CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`verification` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`order_index` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `milestones_mission_order_idx` ON `milestones` (`mission_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `mission_contract_assertions` (
	`id` text PRIMARY KEY NOT NULL,
	`milestone_id` text NOT NULL,
	`title` text NOT NULL,
	`assertion` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`order_index` integer NOT NULL,
	`feature_ids` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`milestone_id`) REFERENCES `milestones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mission_contract_assertions_milestone_idx` ON `mission_contract_assertions` (`milestone_id`);--> statement-breakpoint
CREATE TABLE `mission_features` (
	`id` text PRIMARY KEY NOT NULL,
	`slice_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`acceptance_criteria` text NOT NULL,
	`status` text DEFAULT 'defined' NOT NULL,
	`loop_state` text DEFAULT 'idle' NOT NULL,
	`implementation_attempt_count` integer DEFAULT 0 NOT NULL,
	`validator_attempt_count` integer DEFAULT 0 NOT NULL,
	`task_id` text,
	`generated_from_feature_id` text,
	`generated_from_run_id` text,
	`blocked_reason` text,
	`order_index` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`slice_id`) REFERENCES `slices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mission_features_slice_id_idx` ON `mission_features` (`slice_id`);--> statement-breakpoint
CREATE INDEX `mission_features_task_id_idx` ON `mission_features` (`task_id`);--> statement-breakpoint
CREATE INDEX `mission_features_loop_state_idx` ON `mission_features` (`loop_state`);--> statement-breakpoint
CREATE TABLE `mission_fix_feature_lineage` (
	`id` text PRIMARY KEY NOT NULL,
	`source_feature_id` text NOT NULL,
	`fix_feature_id` text NOT NULL,
	`validator_run_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_feature_id`) REFERENCES `mission_features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fix_feature_id`) REFERENCES `mission_features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`validator_run_id`) REFERENCES `mission_validator_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mission_fix_feature_lineage_uq` ON `mission_fix_feature_lineage` (`source_feature_id`,`fix_feature_id`);--> statement-breakpoint
CREATE TABLE `mission_validator_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_id` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_json` text,
	`pid` integer,
	`pid_starttime` text,
	`paused_at` text,
	FOREIGN KEY (`feature_id`) REFERENCES `mission_features`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mission_validator_runs_feature_started_idx` ON `mission_validator_runs` (`feature_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'planning' NOT NULL,
	`interview_state` text,
	`autopilot_enabled` integer DEFAULT false NOT NULL,
	`autopilot_state` text DEFAULT 'inactive' NOT NULL,
	`last_autopilot_activity_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `missions_status_idx` ON `missions` (`status`);--> statement-breakpoint
CREATE TABLE `slices` (
	`id` text PRIMARY KEY NOT NULL,
	`milestone_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`verification` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`order_index` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`milestone_id`) REFERENCES `milestones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `slices_milestone_order_idx` ON `slices` (`milestone_id`,`order_index`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `mission_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `slice_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `feature_id` text;--> statement-breakpoint
CREATE INDEX `tasks_mission_id_idx` ON `tasks` (`mission_id`);--> statement-breakpoint
CREATE INDEX `tasks_feature_id_idx` ON `tasks` (`feature_id`);