-- What a room's dev requires an applicant's post on X to say: words the post must contain, checked with X when
-- the applicant applies and again when the dev lets them in. Empty when the dev requires none. This is beside
-- `post_brief`, which is the dev's free description of the post and is not checked.

ALTER TABLE rooms ADD COLUMN post_phrase TEXT NOT NULL DEFAULT '';
