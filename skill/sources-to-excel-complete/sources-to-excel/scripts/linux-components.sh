#!/bin/sh
set -eu
# Installed application asset, never assembled from model/user shell input.
if [ "$(id -u)" -ne 0 ]; then
  echo '请在系统授权窗口中允许安装办公和识别组件。' >&2
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo '自动安装支持 Ubuntu / Debian。其他发行版请安装 Python、LibreOffice、Tesseract、AT-SPI 和中文字体后重新检测。' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3 python3-venv python3-pip python3-pyatspi python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 libnss3 libgbm1 libasound2t64 at-spi2-core libreoffice-writer libreoffice-calc tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng poppler-utils fonts-noto-cjk fontconfig curl zstd libsecret-1-0 gnome-keyring xdotool
