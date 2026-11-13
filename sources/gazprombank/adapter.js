// Газпромбанк, интернет-банк ib.online.gpb.ru.
//
// Каждый запрос к API банк подписывает своим защитным скриптом (antifrod.js патчит
// window.fetch). Поэтому запросы выполняются не из адаптера, а внутри страницы банка:
// ctx.page.run открывает кабинет с сохранённой сессией и возвращает ответ.
// Ничего не подделываем — подпись считает код банка в его же странице.

var PAGE_URL = "https://ib.online.gpb.ru/";
var OMNI = "https://omni.online.gpb.ru";
var LOGIN_URL = "https://ib.online.gpb.ru/login";

var CARDS = "/omni-oks-information/api/v2/client/card/list";
var ACCOUNTS = "/omni-oks-information/api/v2/client/account/list";
var DEPOSITS = "/omni-oks-information/api/v2/client/deposit/list";
var HISTORY = "/omni-operation-history/api/v3/client/operation/list/main";

function loginPage(ctx) {
  var session = ctx.page.open({
    url: LOGIN_URL,
    capture: ["cookies"],
    title: "Газпромбанк"
  });
  if (session.cookies) ctx.vault.put("cookies", session.cookies);
}

/** Выполняет запрос из страницы банка и возвращает разобранный JSON. */
function request(ctx, path, body) {
  var payload = JSON.stringify(body || { meta: { channel: "ib" } });
  var script =
    "var r = await fetch(" + JSON.stringify(OMNI + path) + ", {" +
    " method: \"POST\"," +
    " credentials: \"include\"," +
    " headers: {" +
    " \"Content-Type\": \"application/json\"," +
    " \"Accept\": \"application/json\"," +
    " \"GPB-Accept\": \"application/json, text/plain, */*\"," +
    " \"GPB-AcceptLanguage\": \"ru\"" +
    " }," +
    " body: " + JSON.stringify(payload) +
    " });" +
    " if (!r.ok) { throw new Error(\"HTTP \" + r.status); }" +
    " return await r.json();";
  var answer = ctx.page.run(PAGE_URL, script);
  var data = typeof answer === "string" ? JSON.parse(answer) : answer;
  var text = data && data.result !== undefined ? data.result : data;
  if (typeof text === "string") text = JSON.parse(text);
  if (text && text.error) ctx.fail("bank_error", typeof text.error === "object" ? JSON.stringify(text.error) : String(text.error));
  return text;
}


/**
 * Ловит ответы, которые приложение банка запрашивает само.
 *
 * Подпись X-GIB-* ставит их сетевой слой, поэтому мы не дергаем fetch сами,
 * а переключаем раздел кабинета и читаем ответы их же запросов.
 */
function captureRoutes(ctx, routes, timeoutMs) {
  // Перехват уже стоит (его ставит приложение до загрузки кабинета).
  // Ждём, пока кабинет сам запросит карты и вклады, и забираем журнал.
  var script =
    "await new Promise(function(r){setTimeout(r,6000);});" +
    "return window.__finassistLog || [];";
  var answer = ctx.page.run(PAGE_URL, script);
  var data = typeof answer === "string" ? JSON.parse(answer) : answer;
  var text = data && data.result !== undefined ? data.result : data;
  if (typeof text === "string") text = JSON.parse(text);
  return text || [];
}

function findPayload(log, marker) {
  for (var i = 0; i < log.length; i++) {
    var item = log[i];
    if (String(item.url).indexOf(marker) < 0) continue;
    try {
      var parsed = JSON.parse(item.body);
      if (parsed && parsed.data) return parsed;
    } catch (e) {}
  }
  return null;
}

/** Суммы банк отдаёт в копейках; строки с точкой переводим в минорные единицы. */
function minor(value) {
  if (value === null || value === undefined || value === "") return null;
  var number = Number(value);
  if (!isFinite(number)) return null;
  return String(value).indexOf(".") >= 0 ? Math.round(number * 100) : Math.round(number);
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

function shortName(name) {
  if (!name) return null;
  if (typeof name === "string") return text(name);
  return text(name.short) || text(name.client) || text(name.info);
}

function accountFromCard(card) {
  var balance = card.balance || {};
  return {
    externalId: text(card.extId),
    name: shortName(card.name) || "Карта " + (text(card.maskNum) || ""),
    kind: "CARD",
    balanceMinor: minor(balance.value),
    currencyCode: text(balance.currency) || "RUB",
    maskedNumber: text(card.maskNum),
    openedAt: text(card.contractStartDate)
  };
}

function accountFromDeposit(deposit) {
  var balance = deposit.balance || {};
  var detail = deposit.detail || {};
  return {
    externalId: text(deposit.extId),
    name: shortName(deposit.name) || "Вклад " + (text(detail.accNum) || ""),
    kind: "DEPOSIT",
    balanceMinor: minor(balance.value),
    currencyCode: text(balance.currency) || "RUB",
    maskedNumber: text(detail.accNum),
    openedAt: text(deposit.contractStartDate)
  };
}

function accountFromAccount(account) {
  var balance = account.balance || {};
  return {
    externalId: text(account.extId),
    name: shortName(account.name) || "Счёт",
    kind: "ACCOUNT",
    balanceMinor: minor(balance.value),
    currencyCode: text(balance.currency) || "RUB",
    maskedNumber: text(account.maskNum) || text(account.number),
    openedAt: text(account.contractStartDate)
  };
}

function collect(list, mapper, out, seen) {
  for (var i = 0; i < list.length; i++) {
    var item = mapper(list[i]);
    if (!item.externalId || seen[item.externalId]) continue;
    seen[item.externalId] = true;
    out.push(item);
  }
}

/** Повторяет чтение после входа: сессия могла протухнуть между запусками. */
function withSession(ctx, read) {
  try {
    return read();
  } catch (e) {
    loginPage(ctx);
    return read();
  }
}

function readAccounts(ctx) {
  return withSession(ctx, function () { return readAccountsOnce(ctx); });
}

function readAccountsOnce(ctx) {
  // Сначала пробуем поймать запросы самого кабинета: их подписывает их сетевой слой.
  var log = captureRoutes(ctx, ["/cards", "/deposits"], 2500);
  var seen = {};
  var result = [];
  var cards = findPayload(log, "/client/card/list");
  collect(((cards && cards.data && cards.data.cards) || []), accountFromCard, result, seen);
  var deposits = findPayload(log, "/client/deposit/list");
  collect(((deposits && deposits.data && deposits.data.deposits) || []), accountFromDeposit, result, seen);
  if (result.length > 0) return result;

  var urls = [];
  for (var i = 0; i < log.length; i++) urls.push(log[i].url);
  if (urls.length > 0) {
    ctx.fail("capture_empty", "captured " + urls.length + ": " + urls.join(" | ").slice(0, 700));
  }

  // Если кабинет ничего не запросил (другой маршрут), пробуем прямой запрос.
  var direct = request(ctx, CARDS, { meta: { channel: "ib" } });
  collect(((direct.data || {}).cards) || [], accountFromCard, result, seen);
  return result;
}

function bookedDate(operation) {
  var value = text(operation.authDate);
  if (value && value.length >= 10) return value.substring(0, 10);
  return null;
}

function operationFrom(raw, accountId) {
  var amount = raw.authAmount || {};
  var sum = minor(amount.value);
  var direction = text(raw.direction);
  var signed = sum === null ? 0 : (direction === "debit" ? -sum : sum);
  var category = raw.category || {};
  return {
    externalId: text(raw.extOperationId),
    accountId: accountId,
    bookedOn: bookedDate(raw),
    bookedAtEpochMillis: Number(raw.authTimestamp) || null,
    amountMinor: signed,
    currencyCode: text(amount.currency) || "RUB",
    merchant: text(raw.operationName) || text(raw.description),
    description: text(raw.description),
    category: text(category.categoryName) || text(raw.defaultCategoryName),
    mcc: text(raw.operationMcc),
    status: text((raw.state || {}).code),
    isTransfer: false
  };
}

function readHistory(ctx, accountId, from, to) {
  var page = 1;
  var all = [];
  var guard = 0;
  while (guard < 50) {
    guard++;
    var answer = request(ctx, HISTORY, {
      data: {
        filter: { dateFrom: from, dateTo: to, extIds: [accountId] },
        pagination: { pageNumber: page, pageSize: 100 }
      },
      meta: { channel: "ib" }
    });
    var data = answer.data || {};
    var operations = data.operations || [];
    for (var i = 0; i < operations.length; i++) {
      var item = operationFrom(operations[i], accountId);
      if (item.externalId) all.push(item);
    }
    var pagination = data.pagination || {};
    if (pagination.isLastPage === true || operations.length === 0) break;
    page++;
  }
  return all;
}

function readOperations(ctx, range) {
  var accounts = readAccounts(ctx);
  var operations = [];
  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    var part = readHistory(ctx, account.externalId, range.from, range.to);
    for (var j = 0; j < part.length; j++) operations.push(part[j]);
  }
  return { operations: operations, complete: true, gaps: [] };
}
