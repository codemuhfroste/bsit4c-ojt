import multer from "multer";
import { HttpError } from "./auth.js";

// Vercel rejects request bodies over 4.5 MB, so stay safely under that.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const ALLOWED = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
};

// Files are kept in memory and saved to the database (serverless hosts have no persistent disk).
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) =>
    ALLOWED[file.mimetype] ? cb(null, true) : cb(new HttpError(400, "Only PDF, PNG or JPEG files are allowed.")),
});

// The declared type is client-controlled, so also check the file's leading bytes.
export const hasExpectedSignature = (file) => ALLOWED[file.mimetype].every((byte, i) => file.buffer[i] === byte);
