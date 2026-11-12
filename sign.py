#!/usr/bin/env python3
"""Сборка, подпись и публикация пакетов коннекторов FinAssist.

Формат пакета — детерминированный ZIP:
    manifest.json   паспорт (id, version, hosts, permissions, title, entry, icon)
    adapter.js      скрипт коннектора (имя берётся из manifest.entry)
    icon.png        иконка банка (необязательно, имя из manifest.icon)

Подпись — SHA256withRSA по байтам ZIP. Приложение проверяет её вшитым публичным ключом
до разбора архива, поэтому пересборка пакета обязана давать те же байты: время внутри
архива фиксировано, порядок файлов отсортирован.

Команды:
    sign.py build  --src DIR --version N [--min-app-version N] [--channels beta,stable]
    sign.py promote --id vtb --version N          (копирует запись из beta в stable)
    sign.py verify --id vtb --version N
    sign.py list
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PACKAGES = ROOT / "packages"
PRIVATE_KEY = Path(os.environ.get("CONNECTORS_KEY", Path.home() / "connectors-private.pem"))
CHANNELS = ("stable", "beta")
FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def fail(message: str) -> "NoReturn":
    print(f"ошибка: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def deterministic_zip(src: Path, manifest_filename: str, extra_files: list[str]) -> bytes:
    names = [manifest_filename] + sorted(n for n in extra_files if n != manifest_filename)
    buffer = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            path = src / name
            if not path.exists():
                fail(f"нет файла {path}")
            info = zipfile.ZipInfo(filename=name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    buffer.seek(0)
    return buffer.read()


def sign_bytes(data: bytes) -> str:
    if not PRIVATE_KEY.exists():
        fail(f"нет приватного ключа {PRIVATE_KEY}")
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        signature = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", str(PRIVATE_KEY), tmp_path],
            check=True, capture_output=True,
        ).stdout
    finally:
        os.unlink(tmp_path)
    return base64.b64encode(signature).decode("ascii")


def verify_bytes(data: bytes, signature_b64: str) -> bool:
    public_key = ROOT / "keys" / "connectors-public.pem"
    if not public_key.exists():
        fail(f"нет публичного ключа {public_key}")
    with tempfile.NamedTemporaryFile(delete=False) as payload, \
            tempfile.NamedTemporaryFile(delete=False) as sig:
        payload.write(data)
        payload_path, sig_path = payload.name, sig.name
        sig.write(base64.b64decode(signature_b64))
    try:
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", str(public_key),
             "-signature", sig_path, payload_path],
            capture_output=True, text=True,
        )
        return result.returncode == 0
    finally:
        os.unlink(payload_path)
        os.unlink(sig_path)


def read_catalog(channel: str) -> dict:
    path = ROOT / channel / "catalog.json"
    if not path.exists():
        return {"apiVersion": 1, "generatedAtEpochMillis": 0, "adapters": []}
    return json.loads(path.read_text(encoding="utf-8"))


def write_catalog(channel: str, catalog: dict) -> None:
    catalog["generatedAtEpochMillis"] = int(datetime.now(timezone.utc).timestamp() * 1000)
    catalog["adapters"].sort(key=lambda item: (item["id"], item["version"]))
    path = ROOT / channel / "catalog.json"
    path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def upsert(catalog: dict, entry: dict) -> None:
    catalog["adapters"] = [
        item for item in catalog["adapters"]
        if not (item["id"] == entry["id"] and item["version"] == entry["version"])
    ]
    catalog["adapters"].append(entry)


def base_url() -> str:
    config = ROOT / "config.json"
    if not config.exists():
        fail("нет config.json с полем baseUrl")
    return json.loads(config.read_text(encoding="utf-8"))["baseUrl"].rstrip("/")


def build(args: argparse.Namespace) -> None:
    src = Path(args.src)
    manifest_path = src / "manifest.json"
    if not manifest_path.exists():
        fail(f"нет {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entry = manifest.get("entry") or "adapter.js"
    icon = manifest.get("icon") or ""
    if not (src / entry).exists():
        fail(f"нет скрипта {entry}")
    manifest["version"] = args.version
    if args.min_app_version is not None:
        manifest["minAppVersion"] = args.min_app_version
    manifest.setdefault("apiVersion", 1)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    extra = [entry]
    if icon:
        extra.append(icon)
    package_bytes = deterministic_zip(src, "manifest.json", extra)
    digest = sha256_hex(package_bytes)
    signature = sign_bytes(package_bytes)
    if not verify_bytes(package_bytes, signature):
        fail("подпись не проверяется публичным ключом")

    target = PACKAGES / manifest["id"] / f"{args.version}.zip"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(package_bytes)

    catalog_entry = {
        "id": manifest["id"],
        "version": args.version,
        "apiVersion": manifest["apiVersion"],
        "minAppVersion": manifest["minAppVersion"],
        "url": f"{base_url()}/packages/{manifest['id']}/{args.version}.zip",
        "sha256": digest,
        "signature": signature,
        "withdrawn": False,
        "changelog": args.changelog or "",
    }
    for channel in [c.strip() for c in args.channels.split(",") if c.strip()]:
        if channel not in CHANNELS:
            fail(f"неизвестный канал {channel}")
        catalog = read_catalog(channel)
        upsert(catalog, catalog_entry)
        write_catalog(channel, catalog)

    print(f"пакет: {target} ({len(package_bytes)} байт)")
    print(f"sha256: {digest}")
    print(f"каналы: {args.channels}")


def promote(args: argparse.Namespace) -> None:
    beta = read_catalog("beta")
    stable = read_catalog("stable")
    entry = next(
        (item for item in beta["adapters"]
         if item["id"] == args.id and item["version"] == args.version),
        None,
    )
    if entry is None:
        fail(f"в бете нет {args.id} {args.version}")
    package = PACKAGES / args.id / f"{args.version}.zip"
    if not package.exists():
        fail(f"нет файла {package}")
    if sha256_hex(package.read_bytes()) != entry["sha256"]:
        fail("sha256 пакета не совпадает с записью в бете")
    if not verify_bytes(package.read_bytes(), entry["signature"]):
        fail("подпись пакета не проверяется")
    upsert(stable, dict(entry))
    write_catalog("stable", stable)
    print(f"{args.id} {args.version} теперь в стабильном канале")


def verify(args: argparse.Namespace) -> None:
    package = PACKAGES / args.id / f"{args.version}.zip"
    if not package.exists():
        fail(f"нет файла {package}")
    data = package.read_bytes()
    for channel in CHANNELS:
        catalog = read_catalog(channel)
        entry = next(
            (item for item in catalog["adapters"]
             if item["id"] == args.id and item["version"] == args.version),
            None,
        )
        if entry is None:
            continue
        ok_hash = sha256_hex(data) == entry["sha256"]
        ok_sign = verify_bytes(data, entry["signature"])
        print(f"{channel}: sha256={'ok' if ok_hash else 'НЕТ'}, подпись={'ok' if ok_sign else 'НЕТ'}")


def list_catalogs(_args: argparse.Namespace) -> None:
    for channel in CHANNELS:
        catalog = read_catalog(channel)
        print(f"{channel}:")
        for item in sorted(catalog["adapters"], key=lambda i: (i["id"], i["version"])):
            flag = " (отозван)" if item.get("withdrawn") else ""
            print(f"  {item['id']} {item['version']}{flag}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Пакеты коннекторов FinAssist")
    sub = parser.add_subparsers(dest="command", required=True)

    build_parser = sub.add_parser("build", help="собрать, подписать и опубликовать пакет")
    build_parser.add_argument("--src", required=True, help="папка с manifest.json и скриптом")
    build_parser.add_argument("--version", type=int, required=True)
    build_parser.add_argument("--min-app-version", type=int, default=None)
    build_parser.add_argument("--channels", default="beta")
    build_parser.add_argument("--changelog", default="")
    build_parser.set_defaults(func=build)

    promote_parser = sub.add_parser("promote", help="перенести версию из беты в стабильный")
    promote_parser.add_argument("--id", required=True)
    promote_parser.add_argument("--version", type=int, required=True)
    promote_parser.set_defaults(func=promote)

    verify_parser = sub.add_parser("verify", help="проверить пакет по каталогам")
    verify_parser.add_argument("--id", required=True)
    verify_parser.add_argument("--version", type=int, required=True)
    verify_parser.set_defaults(func=verify)

    list_parser = sub.add_parser("list", help="показать каталоги")
    list_parser.set_defaults(func=list_catalogs)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
