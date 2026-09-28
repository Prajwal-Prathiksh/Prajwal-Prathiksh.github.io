#!/bin/sh
# Render the app icons in public/icons from the SVGs in scripts/icons.
# Needs rsvg-convert (librsvg). Run from the repo root: sh scripts/make-icons.sh
set -e
out=public/icons
rsvg-convert -w 192 -h 192 scripts/icons/rounded.svg -o $out/icon-192.png
rsvg-convert -w 512 -h 512 scripts/icons/rounded.svg -o $out/icon-512.png
rsvg-convert -w 512 -h 512 scripts/icons/maskable.svg -o $out/maskable-512.png
rsvg-convert -w 180 -h 180 scripts/icons/maskable.svg -o $out/apple-touch-icon.png
