CREATE TABLE capacity_guards (
  id TEXT PRIMARY KEY,
  allowed INTEGER NOT NULL CONSTRAINT capacity_limit CHECK(allowed=1)
);
ALTER TABLE shares ADD COLUMN history_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_items ADD COLUMN history_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_items ADD COLUMN image_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_replies ADD COLUMN history_bytes INTEGER NOT NULL DEFAULT 0;

UPDATE shares SET history_bytes=256+length(CAST(json_object('question',question,'created_at',created_at) AS BLOB));
UPDATE share_items SET history_bytes=1+length(CAST(json_object('item_id',item_id,'name',name,'category',category,'brand',brand) AS BLOB)),image_bytes=CASE WHEN object_key IS NULL THEN 0 ELSE -1 END;
UPDATE share_replies SET history_bytes=1+length(CAST(json_object('nickname',nickname,'text',text,'item_ids',json(item_ids),'created_at',created_at) AS BLOB));

CREATE VIEW sharing_totals AS
SELECT owner_id,count(*) AS share_count,
  (SELECT count(*) FROM share_items i JOIN shares p ON p.id=i.share_id WHERE p.owner_id=s.owner_id)+
  (SELECT count(*) FROM share_replies r JOIN shares p ON p.id=r.share_id WHERE p.owner_id=s.owner_id) AS entry_count,
  coalesce(sum(history_bytes),0)+
  coalesce((SELECT sum(i.history_bytes) FROM share_items i JOIN shares p ON p.id=i.share_id WHERE p.owner_id=s.owner_id),0)+
  coalesce((SELECT sum(r.history_bytes) FROM share_replies r JOIN shares p ON p.id=r.share_id WHERE p.owner_id=s.owner_id),0) AS history_bytes,
  coalesce((SELECT sum(CASE WHEN i.image_bytes<0 THEN 5242880 ELSE i.image_bytes END) FROM share_items i JOIN shares p ON p.id=i.share_id WHERE p.owner_id=s.owner_id),0) AS snapshot_bytes
FROM shares s GROUP BY owner_id;
