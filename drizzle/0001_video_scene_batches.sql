CREATE TABLE IF NOT EXISTS `video_scene_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`original_filename` text NOT NULL,
	`original_path` text,
	`size_bytes` integer NOT NULL,
	`direct_publish` integer NOT NULL,
	`processing_status` text DEFAULT 'queued' NOT NULL,
	`scene_count` integer,
	`external_task_id` text,
	`failure_code` text,
	`failure_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scene_batches_status_created_idx` ON `video_scene_batches` (`processing_status`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `video_scene_batch_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`claimed_at` integer,
	`stage` text DEFAULT 'queued' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `video_scene_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scene_batch_jobs_queue_idx` ON `video_scene_batch_jobs` (`status`,`available_at`);
