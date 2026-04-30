-- Replace emoji project icons with slugs that the frontend resolves to inline SVGs.
UPDATE "projects" SET "icon" = 'briefcase' WHERE "icon" = '💼';
UPDATE "projects" SET "icon" = 'pencil'    WHERE "icon" = '✍️';
UPDATE "projects" SET "icon" = 'code'      WHERE "icon" = '⌨️';
UPDATE "projects" SET "icon" = 'flask'     WHERE "icon" = '🔬';
UPDATE "projects" SET "icon" = 'compass'   WHERE "icon" = '🧭';
