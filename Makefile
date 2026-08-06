.PHONY: test cov bench bench-update-readme scan

test:
	npm test

cov:
	npm run test:cov

# AIC-83 — scored SRE benchmark. Runs every scenario in
# test/evals/scenarios/*.json and prints the leaderboard.
bench:
	node test/evals/bench.mjs

# Re-run the benchmark and update the "bench:" line in README.md with
# the current average score. Cheap way to keep the badge honest.
bench-update-readme:
	node test/evals/bench.mjs --write-json test/evals/bench-results.json
	@avg=$$(jq -r '.average' test/evals/bench-results.json | awk '{printf "%.2f", $$1}'); \
	 sed -i "s|^bench: v1.*|bench: v1 average $$avg|" README.md 2>/dev/null || true; \
	 echo "average: $$avg"

# AIC-73/-74/-50 — secret + key hygiene.
scan:
	node --experimental-strip-types --no-warnings bin/scan-secrets.mjs --tree
	node --experimental-strip-types --no-warnings bin/scan-secrets.mjs --history
