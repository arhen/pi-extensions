#!/usr/bin/env bash
# Release one or more packages: check → bump → publish → commit + tag → push → pi update.
#
#   npm run release -- pi-core-todo                 # patch
#   npm run release -- --minor pi-add-mode pi-senja
#   npm run release -- --dry-run pi-core-goal       # check + npm publish --dry-run, nothing kept
#
# Flags: --patch (default) | --minor | --major, --dry-run, --no-push, --no-update.
set -euo pipefail

cd "$(dirname "$0")/.."

bump="patch"
dry_run=0
push=1
update=1
names=()
for arg in "$@"; do
	case "$arg" in
	--patch | --minor | --major) bump="${arg#--}" ;;
	--dry-run) dry_run=1 ;;
	--no-push) push=0 ;;
	--no-update) update=0 ;;
	-h | --help)
		sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	-*)
		echo "release: unknown flag $arg" >&2
		exit 2
		;;
	*) names+=("${arg#@arhen/}") ;;
	esac
done
[ ${#names[@]} -gt 0 ] || {
	echo "usage: npm run release -- [--patch|--minor|--major] [--dry-run] [--no-push] [--no-update] <pkg>..." >&2
	exit 2
}

dirs=()
for name in "${names[@]}"; do
	dir=$(find packages -maxdepth 2 -type d -name "$name" -not -path "*/node_modules/*" | head -n 1)
	[ -n "$dir" ] && [ -f "$dir/package.json" ] || {
		echo "release: no package named $name under packages/" >&2
		exit 2
	}
	dirs+=("$dir")
done

if [ -n "$(git status --porcelain)" ]; then
	echo "release: working tree is not clean — commit or stash first" >&2
	exit 1
fi

released=()
for dir in "${dirs[@]}"; do
	pkg=$(node -p "require('./$dir/package.json').name")
	echo "── $pkg ($dir)"
	if node -e "process.exit(require('./$dir/package.json').scripts?.check ? 0 : 1)"; then
		npm run check --workspace "$pkg"
	fi

	npm version "$bump" --workspace "$pkg" --no-git-tag-version >/dev/null
	version=$(node -p "require('./$dir/package.json').version")
	if [ "$dry_run" = 1 ]; then
		# npm rejects a dry run of an already-published version, so preview the bumped one.
		status=0
		npm publish --workspace "$pkg" --dry-run || status=$?
		git checkout -- "$dir/package.json" package-lock.json
		[ "$status" = 0 ] || exit "$status"
		released+=("$pkg@$version")
		continue
	fi
	if ! npm publish --workspace "$pkg"; then
		git checkout -- "$dir/package.json" package-lock.json
		echo "release: publish failed for $pkg; version bump reverted" >&2
		exit 1
	fi
	git add "$dir/package.json" package-lock.json
	git commit -q -m "chore(release): $pkg $version"
	git tag "$pkg@$version"
	released+=("$pkg@$version")
done

[ "$dry_run" = 1 ] && {
	printf 'dry run, would release: %s\n' "${released[@]}"
	exit 0
}

if [ "$push" = 1 ]; then
	git push --quiet
	git push --quiet --tags
fi

if [ "$update" = 1 ] && command -v pi >/dev/null 2>&1; then
	pi_npm="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm"
	for spec in "${released[@]}"; do
		pkg="${spec%@*}"
		version="${spec##*@}"
		# npm now processes a publish for a while before the version resolves; updating earlier is a no-op.
		for _ in $(seq 1 40); do
			[ "$(npm view "$pkg@$version" version --prefer-online 2>/dev/null)" = "$version" ] && break
			sleep 15
		done
		pi update "npm:$pkg" || echo "release: pi update npm:$pkg failed (not installed?)" >&2
		installed="$pi_npm/node_modules/$pkg/package.json"
		# pi's npm can still serve cached metadata (up to 5 min); fetch the exact release directly.
		if [ -f "$installed" ] && [ "$(node -p "require('$installed').version")" != "$version" ]; then
			npm --prefix "$pi_npm" install "$pkg@^$version" --prefer-online --no-audit --no-fund --silent ||
				echo "release: $pkg $version not installed in pi; run: pi update npm:$pkg" >&2
		fi
	done
fi

printf 'released: %s\n' "${released[@]}"
