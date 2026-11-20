#!/bin/sh
set -eu
if ! id -un >/dev/null 2>&1; then
  umask 077
  passwd_file=$(mktemp)
  cat /etc/passwd > "$passwd_file"
  printf 'evq:x:%s:%s::%s:/bin/sh\n' "$(id -u)" "$(id -g)" "${HOME:-/evq-home}" >> "$passwd_file"
  export NSS_WRAPPER_PASSWD="$passwd_file"
  export NSS_WRAPPER_GROUP=/etc/group
  export LD_PRELOAD="/usr/local/lib/libnss_wrapper.so${LD_PRELOAD:+:$LD_PRELOAD}"
fi
exec "$@"
