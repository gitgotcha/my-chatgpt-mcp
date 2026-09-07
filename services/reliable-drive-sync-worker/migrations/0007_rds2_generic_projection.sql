-- RDS V2 migration 0007 (T11): the generic-profile row index.
-- Incremental only: rds2_projection_rows already carries member_key (0006).
-- This adds the index-page access path required by the generic-profile
-- reducer — scope + row_kind + member_key + the stable sort pair — so an
-- affected member's evidence rows can be paged without a table scan.

CREATE INDEX IF NOT EXISTS rds2_projection_member_idx
  ON rds2_projection_rows (
    user_id, namespace, projection_name, generation,
    row_kind, member_key, sort_key, row_key
  );
