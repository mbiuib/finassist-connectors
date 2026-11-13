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

function openSession(ctx) {
  var session = ctx.page.open({
    url: LOGIN_URL,
    capture: ["cookies"],
    title: "Газпромбанк"
  });
  if (session.cookies) ctx.vault.put("cookies", session.cookies);
}

function ensureSession(ctx) {
  if (!ctx.vault.get("cookies")) openSession(ctx);
}

/** Выполняет запрос из страницы банка и возвращает разобранный JSON. */
function request(ctx, path, body) {
  var payload = JSON.stringify(body || { meta: { channel: "ib" } });
  var script =
    "var r = await fetch(" + JSON.stringify(OMNI + path) + ", {" +
    " method: \"POST\"," +
    " credentials: \"include\"," +
    " headers: { \"Content-Type\": \"application/json\", \"Accept\": \"application/json\" }," +
    " body: " + JSON.stringify(payload) +
    " });" +
    " if (!r.ok) { throw new Error(\"HTTP \" + r.status); }" +
    " return await r.json();";
  var answer = ctx.page.run(PAGE_URL, script);
  var data = typeof answer === "string" ? JSON.parse(answer) : answer;
  var text = data && data.result !== undefined ? data.result : data;
  if (typeof text === "string") text = JSON.parse(text);
  if (text && text.error) ctx.fail("bank_error", String(text.error));
  return text;
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

function readAccounts(ctx) {
  ensureSession(ctx);
  var seen = {};
  var result = [];

  var cards = request(ctx, CARDS, { meta: { channel: "ib" } });
  collect(((cards.data || {}).cards) || [], accountFromCard, result, seen);

  var deposits = request(ctx, DEPOSITS, { meta: { channel: "ib" } });
  collect(((deposits.data || {}).deposits) || [], accountFromDeposit, result, seen);

  var accounts = request(ctx, ACCOUNTS, { meta: { channel: "ib" } });
  collect(((accounts.data || {}).accounts) || [], accountFromAccount, result, seen);

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
  ensureSession(ctx);
  var accounts = readAccounts(ctx);
  var operations = [];
  for (var i = 0; i < accounts.length; i++) {
    var account = accounts[i];
    var part = readHistory(ctx, account.externalId, range.from, range.to);
    for (var j = 0; j < part.length; j++) operations.push(part[j]);
  }
  return { operations: operations, complete: true, gaps: [] };
}
