ALTER TABLE `tasks` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `cleanup_reason` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `cleanup_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `provider_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `provider_url` text;--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);