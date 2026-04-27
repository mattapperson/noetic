DROP INDEX `tasks_project_worktree_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_worktree_path_uq` ON `tasks` (`worktree_path`);