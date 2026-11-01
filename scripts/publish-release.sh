#!/bin/sh
# Moves the release branch that installs follow to the current commit. It leaves out .github, as GITHUB_TOKEN may not
# push workflow changes, and installs don't need them.
set -eu
source_commit=$(git rev-parse HEAD)
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git fetch -q origin release; then
  git checkout -q -B release FETCH_HEAD
else
  git checkout -q --orphan release
fi
git read-tree -u --reset "$source_commit"
git rm -r -q --cached --ignore-unmatch .github
rm -rf .github
if git diff --cached --quiet HEAD 2>/dev/null; then
  echo "The release branch is already up to date."
else
  git commit -q -m "Release ${source_commit}"
  git push -q origin release
fi
git checkout -q --force "$source_commit"
