var API = "https://online.vtb.ru";
var PRODUCT_TYPES = [
  "ACCOUNT,CARD,THIRD_CLIENT_CARD,TECHNICAL_CARD,TECHNICAL_ACCOUNT",
  "INSURANCE,INVEST_PRODUCT,LOAN,LOYALTY_PROGRAM,METAL,PACKAGE,SAVING,WALLET,ESCROW," +
    "NPF_ACCOUNT,INVEST_CONTRACT,PACKAGE_SECOND_LEVEL,IBS_CONTRACT,PIF,TRUST_MANAGEMENT"
];

var CANCELLED = [
  "error", "-1", "annulederror", "-2", "insufficienterror", "-3",
  "invalidknferror", "-4", "limitexceedederror", "-5", "rejected", "declined",
  "reversed", "cancelled", "canceled", "denyfraud", "denyaml", "denysanction"
];

function headers(ctx) {
  var result = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9",
    "x-channel": "WWW2",
    "x-platform": "web",
    "Referer": API + "/history"
  };
  var cookies = ctx.vault.get("cookies");
  if (cookies) result["Cookie"] = cookies;
  var auth = ctx.vault.get("authorization");
  if (auth) result["Authorization"] = auth;
  return result;
}

var reloginTried = false;

// Сессия банка умирает между запусками. Тогда вход повторяется один раз: страница
// открывается с сохранённым логином, человеку остаётся подтвердить код из СМС.
function get(ctx, url) {
  var response = ctx.http.get({ url: url, headers: headers(ctx) });
  if ((response.status === 401 || response.status === 403) && !reloginTried) {
    reloginTried = true;
    ctx.vault.put("cookies", null);
    ctx.vault.put("authorization", null);
    openSession(ctx);
    response = ctx.http.get({ url: url, headers: headers(ctx) });
  }
  if (response.status === 401 || response.status === 403) {
    ctx.fail("auth_required", "HTTP " + response.status);
  }
  return response;
}

function openSession(ctx) {
  var auth = ctx.vault.get("authorization");
  var cookies = ctx.vault.get("cookies");
  if (auth && cookies) return;
  // Вход целиком проходит на странице банка: логин и пароль не сохраняются
  // и не подставляются. Человек входит сам и нажимает «Готово».
  var session = ctx.page.open({
    url: API + "/",
    capture: ["cookies", "header:Authorization"],
    title: "ВТБ"
  });
  if (session.cookies) ctx.vault.put("cookies", session.cookies);
  var header = session.headers && (session.headers["Authorization"] || session.headers["authorization"]);
  if (header) ctx.vault.put("authorization", header);
}

function text(value) {
  if (value === null || value === undefined) return null;
  var result = String(value).replace(/^\s+|\s+$/g, "");
  return result.length > 0 ? result : null;
}

function pick(node, keys) {
  for (var i = 0; i < keys.length; i++) {
    var value = text(node[keys[i]]);
    if (value !== null) return value;
  }
  return null;
}

function pickValue(node, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (node[keys[i]] !== null && node[keys[i]] !== undefined) return node[keys[i]];
  }
  return null;
}

function toMinor(value) {
  if (value === null || value === undefined) return null;
  var raw = value;
  if (typeof value === "object") {
    raw = pickValue(value, ["sum", "amount", "value", "balance"]);
  }
  if (raw === null || raw === undefined) return null;
  var normalized = String(raw)
    .replace(/\u00A0/g, " ")
    .replace(/\s/g, "")
    .replace(",", ".");
  var number = parseFloat(normalized);
  if (isNaN(number)) return null;
  return Math.round(number * 100);
}

function currencyOf(value) {
  var code = null;
  if (value && typeof value === "object") {
    code = text(value.currency) || text(value.currencyCode) ||
      (value.currency && (text(value.currency.code) || text(value.currency.name)));
  } else if (typeof value === "string") {
    code = text(value);
  }
  if (!code) return null;
  code = code.toUpperCase();
  return code === "RUR" ? "RUB" : code.substring(0, 3);
}

function last4(value) {
  if (!value) return null;
  var digits = String(value).replace(/[^0-9]/g, "");
  return digits.length >= 4 ? digits.substring(digits.length - 4) : null;
}

function collect(node, kind, found, seen, depth) {
  if (!node || depth > 6) return;
  if (Object.prototype.toString.call(node) === "[object Array]") {
    for (var i = 0; i < node.length; i++) collect(node[i], kind, found, seen, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  var id = pick(node, ["publicId", "id", "internalId"]);
  var number = pick(node, ["number", "cardNumber", "maskedNumber", "last4", "pan"]);
  var name = pick(node, ["name", "productName", "title", "cardName", "description"]);
  var balance = pickValue(node, ["balance", "amount"]);
  if (id && (name || number || balance !== null) && !seen[id]) {
    seen[id] = true;
    var credit = name !== null && name.toLowerCase().indexOf("кредит") >= 0;
    var masked = last4(number);
    found.push({
      externalId: String(id),
      name: name || (masked ? "ВТБ · ·" + masked : "Счёт ВТБ"),
      kind: credit ? "LOAN" : kind,
      balanceMinor: toMinor(balance),
      currencyCode: currencyOf(balance) || "RUB",
      maskedNumber: masked,
      openedAt: dateOnly(pick(node, ["openDate", "openedAt", "openDateTime"]))
    });
  }
  for (var key in node) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      collect(node[key], kind, found, seen, depth + 1);
    }
  }
}

// Форма ответа портфеля: какие поля есть у счёта и карты. Помогает при разборе,
// если банк поменяет состав полей.
function logShape(ctx, name, list) {
  if (!list || !list.length) return;
  var keys = [];
  for (var k in list[0]) keys.push(k);
  ctx.log(name + ": " + list.length + " шт., поля: " + keys.join(","));
}

// Карта не отдельный счёт: банк показывает на каждой карте баланс счёта, к которому
// она выпущена. Если оставить карты счетами, деньги одного счёта считаются столько раз,
// сколько к нему выпущено карт. Сворачиваем карты в счёт-родитель с тем же балансом
// и переводим операции карт на него.
var CARD_PARENT = {};

function looksLikeCard(name) {
  if (!name) return false;
  var text = String(name);
  // «Мастер-счёт в рублях» и «Накопительный ВТБ-Счёт» - счета, даже если в названии
  // встретилось слово «карта»: карта - это отдельный продукт с тем же остатком.
  if (/сч[её]т/i.test(text)) return false;
  return /карт/i.test(text);
}

function looksLikeAccount(name) {
  return name ? /сч[её]т/i.test(String(name)) : false;
}

function collapseCards(found) {
  var groups = {};
  for (var i = 0; i < found.length; i++) {
    var key = found[i].currencyCode + "|" + found[i].balanceMinor;
    if (!groups[key]) groups[key] = [];
    groups[key].push(found[i]);
  }
  var merged = [];
  for (var j = 0; j < found.length; j++) merged.push(found[j]);
  for (var groupKey in groups) {
    var group = groups[groupKey];
    var parents = [];
    var cards = [];
    for (var k = 0; k < group.length; k++) {
      if (looksLikeCard(group[k].name)) cards.push(group[k]);
      else if (looksLikeAccount(group[k].name)) parents.push(group[k]);
    }
    // Сворачиваем только при однозначной картине: один счёт и хотя бы одна карта.
    if (parents.length !== 1 || cards.length === 0) continue;
    var parent = parents[0];
    for (var c = 0; c < cards.length; c++) {
      CARD_PARENT[cards[c].externalId] = parent.externalId;
      var index = merged.indexOf(cards[c]);
      if (index >= 0) merged.splice(index, 1);
    }
  }
  return merged;
}

function readAccounts(ctx) {
  var found = [];
  var seen = {};
  for (var i = 0; i < PRODUCT_TYPES.length; i++) {
    var url = API + "/msa/api-gw/private/portfolio/portfolio-main-page/portfolios/active" +
      "?requestProductTypes=" + encodeURIComponent(PRODUCT_TYPES[i]);
    var response = get(ctx, url);
    if (response.status !== 200) continue;
    var body = JSON.parse(response.body);
    logShape(ctx, "accounts", body.accounts);
    logShape(ctx, "cards", body.cards);
    logShape(ctx, "deposits", body.deposits);
    collect(body.accounts, "CARD", found, seen, 0);
    collect(body.deposits, "DEPOSIT", found, seen, 0);
    collect(body.loans, "LOAN", found, seen, 0);
    collect(body.metalAccounts, "DEPOSIT", found, seen, 0);
    collect(body.investAgreements, "BROKERAGE", found, seen, 0);
    collect(body.insurances, "CARD", found, seen, 0);
    collect(body.cards, "CARD", found, seen, 0);
  }
  CARD_PARENT = {};
  var collapsed = collapseCards(found);
  // Карта и счёт читаются разными вызовами адаптера: связь нужно сохранить между ними.
  var mapping = {};
  for (var cardId in CARD_PARENT) {
    if (Object.prototype.hasOwnProperty.call(CARD_PARENT, cardId)) mapping[cardId] = CARD_PARENT[cardId];
  }
  ctx.state.set("card-parent", JSON.stringify(mapping));
  return collapsed;
}

function dateOnly(value) {
  if (!value) return null;
  var raw = String(value);
  var iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];
  var dotted = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dotted) return dotted[3] + "-" + dotted[2] + "-" + dotted[1];
  return null;
}

function parseDay(value) {
  var iso = dateOnly(value);
  if (!iso) return null;
  return new Date(iso + "T00:00:00.000Z");
}

function isoDay(date) {
  return date.toISOString().substring(0, 10);
}

function splitMonths(from, to) {
  var result = [];
  var start = parseDay(from);
  var end = parseDay(to);
  if (!start || !end) return result;
  while (start.getTime() <= end.getTime()) {
    var monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    var partEnd = monthEnd.getTime() < end.getTime() ? monthEnd : end;
    result.push({ from: isoDay(start), to: isoDay(partEnd) });
    start = new Date(partEnd.getTime() + 24 * 60 * 60 * 1000);
  }
  return result;
}

function historyUrl(from, to) {
  return API + "/msa/api-gw/private/history-hub/history-hub-homer/v1/history/byUser" +
    "?dateFrom=" + encodeURIComponent(from + "T00:00:00.000+03:00") +
    "&dateTo=" + encodeURIComponent(to + "T23:59:59.999+03:00");
}

function isCancelled(status) {
  if (!status) return false;
  var normalized = String(status).toLowerCase();
  if (CANCELLED.indexOf(normalized) >= 0) return true;
  if (normalized.indexOf("deny") === 0) return true;
  return normalized.indexOf("отмен") >= 0 || normalized.indexOf("отклон") >= 0;
}

function hash(value) {
  var result = 5381;
  for (var i = 0; i < value.length; i++) {
    result = ((result << 5) + result + value.charCodeAt(i)) & 0x7fffffff;
  }
  return result.toString(36);
}

function parseOperation(item) {
  var amountSource = item.operationAmount || item.transactionAmount || item.amount;
  var amount = toMinor(amountSource);
  if (amount === null || amount === 0) return null;
  var dateText = item.operationDate || item.transactionDate || item.date;
  var day = dateOnly(dateText);
  if (!day) return null;
  var status = item.status || item.operationStatus || item.state ||
    (item.status && item.status.code);
  if (isCancelled(status)) return null;
  var debit = item.debet === true || item.debit === true ||
    String(item.creditDebitIndicator || "").toLowerCase() === "debit";
  var account = item.accountProductId || item.productId || item.cardProductId ||
    (item.product && (item.product.publicId || item.product.id)) || "";
  if (CARD_PARENT[String(account)]) account = CARD_PARENT[String(account)];
  var merchant = (item.merchant && (item.merchant.title || item.merchant.name)) ||
    (typeof item.merchant === "string" ? item.merchant : null);
  var category = (item.parentCategory && item.parentCategory.name) ||
    (item.category && item.category.name) || null;
  var receiver = item.receiver && item.receiver.name;
  var description = item.operationName || item.fullOperationName || item.description || null;
  var externalId = item.internalId || item.publicId || item.id;
  if (!externalId) {
    externalId = hash([day, amount, account, merchant, description].join("|"));
  }
  var millis = Date.parse(dateText);
  var transfer = /перевод/i.test(String(category || "")) ||
    /перевод/i.test(String(description || "")) ||
    /transfer/i.test(String(item.operationCode || ""));
  return {
    externalId: String(externalId),
    accountId: String(account),
    bookedOn: day,
    bookedAtEpochMillis: isNaN(millis) ? null : millis,
    amountMinor: debit ? -Math.abs(amount) : Math.abs(amount),
    currencyCode: currencyOf(amountSource) || "RUB",
    merchant: merchant || null,
    description: description,
    counterparty: receiver || merchant || null,
    category: category,
    mcc: item.mcc !== undefined && item.mcc !== null ? String(item.mcc) : null,
    status: status ? String(status) : null,
    isTransfer: transfer,
    feeMinor: toMinor(item.feeAmount)
  };
}

function readChunk(ctx, from, to) {
  var response = get(ctx, historyUrl(from, to));
  if (response.status === 531) {
    var months = splitMonths(from, to);
    if (months.length <= 1) {
      return { operations: [], gaps: [{ from: from, to: to }] };
    }
    var merged = { operations: [], gaps: [] };
    for (var i = 0; i < months.length; i++) {
      var part = readChunk(ctx, months[i].from, months[i].to);
      merged.operations = merged.operations.concat(part.operations);
      merged.gaps = merged.gaps.concat(part.gaps);
    }
    return merged;
  }
  if (response.status !== 200) {
    ctx.fail("network", "HTTP " + response.status);
  }
  var body;
  try {
    body = JSON.parse(response.body);
  } catch (error) {
    ctx.fail("schema_changed", "история пришла не JSON");
  }
  var source = body.operations || [];
  var operations = [];
  for (var j = 0; j < source.length; j++) {
    var parsed = parseOperation(source[j]);
    if (parsed) operations.push(parsed);
  }
  var announced = body.total || body.totalCount || body.totalElements || body.totalOperations || 0;
  var truncated = body.hasMore === true || body.hasNext === true ||
    (announced > 0 && announced > operations.length);
  var gaps = truncated ? [{ from: from, to: to }] : [];
  return { operations: operations, gaps: gaps };
}

function readOperations(ctx, range) {
  try {
    CARD_PARENT = JSON.parse(ctx.state.get("card-parent") || "{}");
  } catch (error) {
    CARD_PARENT = {};
  }
  var result = readChunk(ctx, range.from, range.to);
  return {
    operations: result.operations,
    gaps: result.gaps,
    complete: result.gaps.length === 0
  };
}

function closeSession(ctx) {
  ctx.state.set("last-call", String(ctx.now()));
}
