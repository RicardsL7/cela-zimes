#!/usr/bin/env bash
# Parallel test for supabase/rides-14-accept.sql (audit A02): two sessions accept two different offers of the same
# request at the same moment. Exactly one must win; the other must get request_not_open. Local database only.
# Usage: PGHOST=/tmp PGPORT=5499 PGUSER=postgres bash tests/rides-accept-parallel.sh <database>
set -u
DB="${1:?database name}"
PSQL=(psql -X -q -t -A -d "$DB")
A=a0000000-0000-0000-0000-0000000000aa; REQ=11111111-0000-0000-0000-0000000000aa
O1=22222222-0000-0000-0000-0000000000a1; O2=22222222-0000-0000-0000-0000000000a2
D1=b0000000-0000-0000-0000-0000000000a1; D2=b0000000-0000-0000-0000-0000000000a2

cleanup() { "${PSQL[@]}" -c "delete from ride_offers where request_id = '$REQ'; delete from ride_requests where id = '$REQ';
  delete from profiles where id in ('$A','$D1','$D2'); delete from auth.users where id in ('$A','$D1','$D2');" >/dev/null 2>&1; }
cleanup
"${PSQL[@]}" -v ON_ERROR_STOP=1 -c "
insert into auth.users (id) values ('$A'), ('$D1'), ('$D2');
insert into profiles (id, name) values ('$A', 'Paralēlais A'), ('$D1', 'Šoferis 1'), ('$D2', 'Šoferis 2');
insert into ride_requests (id, user_id, from_lat, from_lng, to_lat, to_lng, depart_at)
  values ('$REQ', '$A', 56.95, 24.10, 56.97, 24.15, now() + interval '1 hour');
insert into ride_offers (id, request_id, driver_id, eta_min) values ('$O1', '$REQ', '$D1', 5), ('$O2', '$REQ', '$D2', 6);" >/dev/null || exit 1

accept() {  # $1 offer, $2 seconds to hold the transaction open after accepting
  "${PSQL[@]}" -c "begin; select set_config('request.jwt.claim.sub', '$A', true); set local role authenticated;
    select ride_offer_accept('$1'); select pg_sleep($2); commit;" 2>&1
}
accept "$O1" 2 > /tmp/cz-par-1.out &
P1=$!
sleep 0.5                                   # session 1 holds the request lock; session 2 must wait for it
accept "$O2" 0 > /tmp/cz-par-2.out &
P2=$!
wait $P1 $P2

fails=0
check() { if [ "$2" = "1" ]; then echo "PASS: $1"; else echo "FAIL: $1"; fails=$((fails+1)); fi; }
check "session 1 accepted" "$(grep -q '"ok": true' /tmp/cz-par-1.out && echo 1)"
check "session 2 got request_not_open" "$(grep -q 'request_not_open' /tmp/cz-par-2.out && echo 1)"
check "exactly one accepted offer" "$([ "$("${PSQL[@]}" -c "select count(*) from ride_offers where request_id = '$REQ' and status = 'accepted'")" = 1 ] && echo 1)"
check "the winner is offer 1" "$([ "$("${PSQL[@]}" -c "select status from ride_offers where id = '$O1'")" = accepted ] && echo 1)"
check "the other offer is declined" "$([ "$("${PSQL[@]}" -c "select status from ride_offers where id = '$O2'")" = declined ] && echo 1)"
check "request is matched" "$([ "$("${PSQL[@]}" -c "select status from ride_requests where id = '$REQ'")" = matched ] && echo 1)"
cleanup; rm -f /tmp/cz-par-1.out /tmp/cz-par-2.out
exit $fails
