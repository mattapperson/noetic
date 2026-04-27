CREATE TABLE `task_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_sessions_task_id_idx` ON `task_sessions` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_sessions_task_session_uq` ON `task_sessions` (`task_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_root` text NOT NULL,
	`worktree_path` text NOT NULL,
	`title` text NOT NULL,
	`branch` text,
	`head_sha` text,
	`status` text NOT NULL,
	`review_status` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_worktree_uq` ON `tasks` (`project_root`,`worktree_path`);--> statement-breakpoint
CREATE INDEX `tasks_project_root_idx` ON `tasks` (`project_root`);--> statement-breakpoint
CREATE INDEX `tasks_last_seen_idx` ON `tasks` (`last_seen_at`);