- On every merge to main, update the "Unreleased" section of CHANGELOG.md
  with a bullet per PR grouped by type (feat / fix / chore / docs / test).
- On every new git tag, close out "Unreleased" into a versioned section
  and open a draft GitHub release with the same content.
- Weekly: read the past week's commits and flag any missing from the
  changelog (author forgot to describe user impact).
- Never spam. Every action must correspond to a real merge or tag.
