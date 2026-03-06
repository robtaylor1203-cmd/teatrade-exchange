-- Migration: add URL column to news table and enforce uniqueness
ALTER TABLE public.news
ADD COLUMN IF NOT EXISTS url TEXT UNIQUE;

COMMENT ON COLUMN public.news.url IS 'Source URL of the news article';
