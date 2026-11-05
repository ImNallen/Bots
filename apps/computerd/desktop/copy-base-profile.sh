#!/bin/sh
# A new bot's profile starts as a copy of the base. This runs before each start of its browser, as the browser user, and does
# nothing once the profile exists. A kill midway leaves only the .tmp directory, which the next start replaces. A bot id cannot
# contain a dot, so that name never collides with a bot.
#
# The base is /home/browser/profile, where the shared browser kept its logins. Nothing opens or moves it.
set -eu
base=${BASE_PROFILE:-/home/browser/profile}
profiles=${PROFILES_DIR:-/home/browser/profiles}
final=$profiles/$BOT_ID
tmp=$final.tmp

[ -d "$final" ] && exit 0
mkdir -p "$profiles"
rm -rf "$tmp"
mkdir "$tmp"
# A VM with no base yet gives an empty profile.
if [ -d "$base" ]; then
  cp -a "$base/." "$tmp/"
fi
# These name the browser that last held the base, and they mean nothing in a copy.
rm -f "$tmp"/Singleton*
sync
mv "$tmp" "$final"
