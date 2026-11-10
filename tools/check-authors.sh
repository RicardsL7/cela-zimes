#!/usr/bin/env bash
# B06 (audits 2): jaunajos commit autora un iesniedzēja e-pastam jābūt GitHub noreply adresei, ne personīgai.
# Lieto: bash tools/check-authors.sh            — pārbauda diapazonu no vides (CI) vai tikai pēdējo commit
#        bash tools/check-authors.sh A..B       — pārbauda norādīto diapazonu
# CI: BASE = pull request bāzes commit, BEFORE = commit pirms push. Vecā vēsture netiek pārbaudīta (to nepārraksta).
# Atļauts: <id>+<vārds>@users.noreply.github.com, <vārds>@users.noreply.github.com, noreply@github.com.
set -euo pipefail

range="${1:-}"
if [ -z "$range" ]; then
  if [ -n "${BASE:-}" ] && git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
    range="${BASE}..HEAD"
  elif [ -n "${BEFORE:-}" ] && [ "${BEFORE}" != "0000000000000000000000000000000000000000" ] \
       && git cat-file -e "${BEFORE}^{commit}" 2>/dev/null; then
    range="${BEFORE}..HEAD"
  else
    range="-1"
  fi
fi

ok_re='(@users\.noreply\.github\.com|^noreply@github\.com)$'
bad=0; n=0
while IFS='|' read -r sha ae ce; do
  [ -z "$sha" ] && continue
  n=$((n + 1))
  for e in "$ae" "$ce"; do
    if ! [[ "$e" =~ $ok_re ]]; then
      # adresi neizdrukā pilnībā (lai žurnālā neatkārtotu personīgo e-pastu) — tikai domēnu
      echo "KĻŪDA: commit $sha — e-pasts nav GitHub noreply (domēns: ${e#*@})"
      bad=1
    fi
  done
done < <(git log --format='%h|%ae|%ce' $range)

if [ "$bad" -ne 0 ]; then
  echo "Ieslēdz GitHub → Settings → Emails: „Keep my email addresses private” un „Block command line pushes that expose my email”."
  exit 1
fi
echo "Commit autori kārtībā ($n commit, diapazons: $range)."
