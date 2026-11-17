-- Custom migration: let the products bucket accept short MP4/WebM videos (hero slides in the store folder).
--
-- The bucket stays public-read and keeps the same path policies; only the allowed types and the size ceiling change.
-- The API still enforces the real limits per file: images 5 MB, videos 50 MB and only in the store folder.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage.buckets not found - skipping bucket update';
    RETURN;
  END IF;

  UPDATE storage.buckets
     SET file_size_limit = 52428800,
         allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']
   WHERE id = 'products';
END $$;
