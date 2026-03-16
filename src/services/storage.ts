import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';

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
  console.log('S3 not configured – using local storage');
}

/**
 * Sube un archivo al storage configurado.
 * Si S3 está configurado, sube al bucket; de lo contrario usa el disco local.
 *
 * @param file  Archivo proveniente de multer (ya guardado en disco por multer)
 * @returns     URL pública o ruta relativa al archivo
 */
export async function uploadFile(file: Express.Multer.File): Promise<string> {
  if (isS3Configured && s3Client) {
    const fileContent = fs.readFileSync(file.path);
    const key = `products/${file.filename}`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
        Key: key,
        Body: fileContent,
        ContentType: file.mimetype,
      })
    );

    // Eliminar archivo temporal del disco
    fs.unlinkSync(file.path);

    return `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
  }

  // Storage local – devolver ruta relativa servida por express.static
  return `/uploads/${file.filename}`;
}

/**
 * Elimina un archivo del storage.
 * Determina si es S3 o local según la URL.
 */
export async function deleteFile(fileUrl: string): Promise<void> {
  try {
    if (fileUrl.startsWith('http') && isS3Configured && s3Client) {
      // Extraer key de la URL de S3
      const url = new URL(fileUrl);
      const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;

      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: env.AWS_S3_BUCKET,
          Key: key,
        })
      );
    } else {
      // Archivo local
      const filename = path.basename(fileUrl);
      const filePath = path.join(env.UPLOAD_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (error) {
    console.error('Error deleting file:', error);
  }
}
