CREATE TABLE "dmarc_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"org_name" text NOT NULL,
	"report_id" text DEFAULT '' NOT NULL,
	"date_begin" timestamp with time zone NOT NULL,
	"date_end" timestamp with time zone NOT NULL,
	"policy" jsonb NOT NULL,
	"records" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dmarc_reports" ADD CONSTRAINT "dmarc_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dmarc_reports_workspace_hash_unique" ON "dmarc_reports" USING btree ("workspace_id","payload_hash");