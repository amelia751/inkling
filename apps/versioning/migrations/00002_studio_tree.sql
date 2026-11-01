-- todo10 Phase 2: a release pins the Studio definition its labels were made with.
-- studio_tree is the git tree id of the released commit's `.studio/` subtree
-- (plugins.lock.json, tasks/<id>/environment.json, tasks/<id>/README.md); NULL
-- when that commit carries none.

-- +goose Up
ALTER TABLE versioning.dataset_releases ADD COLUMN studio_tree text CHECK (studio_tree IS NULL OR studio_tree ~ '^[0-9a-f]{40}$');

-- +goose Down
ALTER TABLE versioning.dataset_releases DROP COLUMN studio_tree;
