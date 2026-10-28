import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

/**
 * Almacenamiento de archivos.
 *
 * Hay dos tipos de archivo:
 * - Públicos (imágenes de productos): se sirven sin login.
 * - Privados (documentos de pacientes y de notas): nunca tienen URL pública.
 *   Se descargan con un enlace temporal (5 min) que entrega un endpoint con permisos.
 *
 * Referencias guardadas en la base de datos:
 * - Público local:  /uploads/public/<archivo>
 * - Público S3:     https://<bucket>.s3.<region>.amazonaws.com/products/<archivo>
 * - Privado local:  local:private/<archivo>
 * - Privado S3:     s3:documentos/<archivo>
 * - Antiguas (antes de este cambio): uploads/<archivo>, /uploads/<archivo> o URL de S3.
 */

const isS3Configured =
  env.AWS_ACCESS_KEY_ID !== '' &&
  env.AWS_SECRET_ACCESS_KEY !== '' &&
  env.AWS_S3_BUCKET !== '';

let s3Client: S3Client | null = null;

if (isS3Configured) {
  s3Client = new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  console.log(`S3 storage configured (bucket: ${env.AWS_S3_BUCKET})`);
} else {
  console.log(`S3 not configured – using local storage (${path.resolve(env.UPLOAD_DIR)})`);
}

export const UPLOAD_ROOT = path.resolve(env.UPLOAD_DIR);
export const PUBLIC_DIR = path.join(UPLOAD_ROOT, 'public');
export const PRIVATE_DIR = path.join(UPLOAD_ROOT, 'private');

for (const dir of [UPLOAD_ROOT, PUBLIC_DIR, PRIVATE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const DOWNLOAD_TTL_SECONDS = 300;

export interface EstadoAlmacenamiento {
  tipo: 's3' | 'volumen' | 'local';
  /** false = los archivos se borran en el próximo deploy. */
  persistente: boolean;
  detalle: string;
}

/** Dónde quedan los archivos y si sobreviven a un deploy. */
export function estadoAlmacenamiento(): EstadoAlmacenamiento {
  if (isS3Configured) {
    return { tipo: 's3', persistente: true, detalle: `Amazon S3 (bucket ${env.AWS_S3_BUCKET}).` };
  }
  const volumen = env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH) : '';
  if (volumen && (UPLOAD_ROOT === volumen || UPLOAD_ROOT.startsWith(volumen + path.sep))) {
    return { tipo: 'volumen', persistente: true, detalle: `Volumen de Railway (${UPLOAD_ROOT}).` };
  }
  if (env.EN_RAILWAY) {
    return {
      tipo: 'local',
      persistente: false,
      detalle: volumen
        ? `UPLOAD_DIR (${UPLOAD_ROOT}) está fuera del volumen (${volumen}): los archivos se borran en cada deploy.`
        : 'Disco temporal de Railway: los archivos se borran en cada deploy. Agrega un volumen al servicio o configura S3.',
    };
  }
  return { tipo: 'local', persistente: true, detalle: `Disco local (${UPLOAD_ROOT}).` };
}

interface UploadOptions {
  /** true para documentos de pacientes o notas. Por defecto false (imagen pública). */
  privado?: boolean;
}

/**
 * Sube un archivo (ya guardado en disco por multer) y devuelve la referencia a guardar.
 */
export async function uploadFile(file: Express.Multer.File, opts: UploadOptions = {}): Promise<string> {
  const privado = opts.privado ?? false;

  if (isS3Configured && s3Client) {
    const fileContent = fs.readFileSync(file.path);
    const key = `${privado ? 'documentos' : 'products'}/${file.filename}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
        Key: key,
        Body: fileContent,
        ContentType: file.mimetype,
      })
    );

    fs.unlinkSync(file.path);

    if (privado) return `s3:${key}`;
    return `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
  }

  const destDir = privado ? PRIVATE_DIR : PUBLIC_DIR;
  const dest = path.join(destDir, file.filename);
  fs.renameSync(file.path, dest);

  return privado ? `local:private/${file.filename}` : `/uploads/public/${file.filename}`;
}

/** Ruta absoluta segura dentro de UPLOAD_ROOT, o null si se sale de la carpeta. */
export function safeLocalPath(relative: string): string | null {
  const resolved = path.resolve(UPLOAD_ROOT, relative);
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep)) return null;
  return resolved;
}

type ParsedRef =
  | { kind: 's3'; key: string }
  | { kind: 'local'; relative: string }
  | { kind: 'external'; url: string };

function parseRef(ref: string): ParsedRef {
  if (ref.startsWith('s3:')) return { kind: 's3', key: ref.slice(3) };
  if (ref.startsWith('local:')) return { kind: 'local', relative: ref.slice(6) };

  if (ref.startsWith('http')) {
    if (isS3Configured && ref.includes(`${env.AWS_S3_BUCKET}.s3.`)) {
      const key = new URL(ref).pathname.replace(/^\//, '');
      return { kind: 's3', key };
    }
    return { kind: 'external', url: ref };
  }

  // Rutas antiguas: "uploads/123.pdf", "/uploads/123.pdf", "/uploads/public/x.png"
  const cleaned = ref.replace(/^\/?uploads\//, '');
  return { kind: 'local', relative: cleaned };
}

/**
 * Devuelve un enlace temporal de descarga para un archivo.
 * Llamar solo después de verificar que el usuario tiene permiso.
 * @param baseUrl origen del backend (ej. https://api.midominio.cl), para armar enlaces locales.
 */
export async function getDownloadUrl(ref: string, baseUrl: string): Promise<string | null> {
  const parsed = parseRef(ref);

  if (parsed.kind === 's3') {
    if (!s3Client) return null;
    return getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: parsed.key }),
      { expiresIn: DOWNLOAD_TTL_SECONDS }
    );
  }

  if (parsed.kind === 'local') {
    const abs = safeLocalPath(parsed.relative);
    if (!abs || !fs.existsSync(abs)) return null;
    const token = jwt.sign({ purpose: 'file', rel: parsed.relative }, env.JWT_SECRET, {
      expiresIn: DOWNLOAD_TTL_SECONDS,
    });
    return `${baseUrl}/api/files/descarga/${token}`;
  }

  return parsed.url;
}

/** Valida un token de descarga y devuelve la ruta absoluta del archivo. */
export function resolveDownloadToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { purpose?: string; rel?: string };
    if (payload.purpose !== 'file' || !payload.rel) return null;
    const abs = safeLocalPath(payload.rel);
    if (!abs || !fs.existsSync(abs)) return null;
    return abs;
  } catch {
    return null;
  }
}

/** Lee el contenido de un archivo guardado (para enviarlo a un proveedor externo, ej. firma). */
export async function readFileBuffer(ref: string): Promise<Buffer | null> {
  const parsed = parseRef(ref);

  if (parsed.kind === 's3') {
    if (!s3Client) return null;
    const obj = await s3Client.send(new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: parsed.key }));
    if (!obj.Body) return null;
    return Buffer.from(await obj.Body.transformToByteArray());
  }

  if (parsed.kind === 'local') {
    const abs = safeLocalPath(parsed.relative);
    if (!abs || !fs.existsSync(abs)) return null;
    return fs.readFileSync(abs);
  }

  return null;
}

/**
 * Guarda un archivo generado por el sistema (ej. PDF firmado que entrega el proveedor)
 * y devuelve la referencia a guardar en la base de datos.
 */
export async function saveBuffer(
  buffer: Buffer,
  nombre: string,
  contentType: string,
  opts: UploadOptions = {}
): Promise<string> {
  const privado = opts.privado ?? true;
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${nombre.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  if (isS3Configured && s3Client) {
    const key = `${privado ? 'documentos' : 'products'}/${filename}`;
    await s3Client.send(
      new PutObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key, Body: buffer, ContentType: contentType })
    );
    if (privado) return `s3:${key}`;
    return `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
  }

  const dest = path.join(privado ? PRIVATE_DIR : PUBLIC_DIR, filename);
  fs.writeFileSync(dest, buffer);
  return privado ? `local:private/${filename}` : `/uploads/public/${filename}`;
}

/**
 * Elimina un archivo del storage.
 */
export async function deleteFile(ref: string): Promise<void> {
  try {
    const parsed = parseRef(ref);
    if (parsed.kind === 's3' && s3Client) {
      await s3Client.send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: parsed.key }));
    } else if (parsed.kind === 'local') {
      const abs = safeLocalPath(parsed.relative);
      if (abs && fs.existsSync(abs)) fs.unlinkSync(abs);
    }
  } catch (error) {
    console.error('Error deleting file:', error);
  }
}
