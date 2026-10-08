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

	if [ "$dry_run" = 1 ]; then
		npm publish --workspace "$pkg" --dry-run
		continue
	fi

	npm version "$bump" --workspace "$pkg" --no-git-tag-version >/dev/null
	version=$(node -p "require('./$dir/package.json').version")
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
	echo "dry run: nothing bumped, published, or committed"
	exit 0
}

if [ "$push" = 1 ]; then
	git push --quiet
	git push --quiet --tags
fi

if [ "$update" = 1 ] && command -v pi >/dev/null 2>&1; then
	for spec in "${released[@]}"; do
		pkg="${spec%@*}"
		pi update "npm:$pkg" || echo "release: pi update npm:$pkg failed (not installed?)" >&2
	done
fi

printf 'released: %s\n' "${released[@]}"
