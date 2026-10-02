-- A camera can be this computer's own webcam, shown in the browser for testing (source = 'webcam') instead of a network stream.
ALTER TABLE cameras ADD COLUMN source TEXT NOT NULL DEFAULT 'stream';
