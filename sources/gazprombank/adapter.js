// Газпромбанк, интернет-банк ib.online.gpb.ru.
//
// Каркас адаптера: вход открывается страницей банка, человек проходит капчу и коды.
// Чтение счетов и истории подключается после разбора запросов личного кабинета:
// без записанного обмена реализовывать URL'ы наугад нельзя.

var LOGIN_URL = "https://ib.online.gpb.ru/login";

/** Открывает страницу входа банка в WebView приложения. */
function openSession(ctx) {
  if (ctx.vault.get("cookies")) return;
  // Логин и пароль остаются на странице банка: человек проходит вход сам,
  // приложение забирает только cookies сессии после подтверждения.
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

function readAccounts(ctx) {
  ensureSession(ctx);
  ctx.fail("not_implemented", "Газпромбанк: разбор счетов ещё не реализован");
}

function readOperations(ctx, range) {
  ensureSession(ctx);
  ctx.fail("not_implemented", "Газпромбанк: разбор операций ещё не реализован");
}
