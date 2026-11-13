import mongoose from 'mongoose';

/**
 * Migración única de la base de datos a otro servidor Mongo (ej. el de Railway).
 *
 * Si MIGRAR_BD_DESTINO está definida, al arrancar se copian todas las colecciones e índices
 * desde MONGODB_URI hacia esa URI y el servidor queda usando el destino desde ese mismo arranque.
 * La copia se hace una sola vez: queda una marca en la colección `_migracion` del destino.
 * Terminada la migración, apuntar MONGODB_URI al destino y borrar MIGRAR_BD_DESTINO.
 *
 * @returns la URI que debe usar el servidor, o null si no hay migración configurada o falló
 *          (en ese caso se sigue con MONGODB_URI, sin tocar nada).
 */
export async function migrarBdSiCorresponde(origenUri: string): Promise<string | null> {
  const destinoUri = process.env.MIGRAR_BD_DESTINO;
  if (!destinoUri || destinoUri === origenUri) return null;

  let origen: mongoose.Connection | undefined;
  let destino: mongoose.Connection | undefined;
  try {
    destino = await mongoose.createConnection(destinoUri, { serverSelectionTimeoutMS: 15000 }).asPromise();
    const dbDestino = destino.db!;
    const marca = await dbDestino.collection('_migracion').findOne({ estado: 'completa' });
    if (marca) {
      console.log(`[migración BD] Ya realizada el ${marca.fecha?.toISOString?.() ?? marca.fecha}. Usando la base de destino.`);
      return destinoUri;
    }

    origen = await mongoose.createConnection(origenUri, { serverSelectionTimeoutMS: 15000 }).asPromise();
    const dbOrigen = origen.db!;
    const colecciones = (await dbOrigen.listCollections().toArray())
      .filter((c) => c.type !== 'view' && !c.name.startsWith('system.'))
      .map((c) => c.name);

    // Destino a medio copiar (intento anterior fallido): se limpia y se copia de nuevo.
    const existentes = (await dbDestino.listCollections().toArray()).map((c) => c.name);
    for (const nombre of existentes) await dbDestino.collection(nombre).drop();

    const conteos: Record<string, number> = {};
    for (const nombre of colecciones) {
      const docs = await dbOrigen.collection(nombre).find({}).toArray();
      const col = dbDestino.collection(nombre);
      if (docs.length) await col.insertMany(docs, { ordered: true });
      else await dbDestino.createCollection(nombre);

      for (const idx of await dbOrigen.collection(nombre).indexes()) {
        if (idx.name === '_id_') continue;
        const { key, v, ns, background, ...opciones } = idx as Record<string, any>;
        await col.createIndex(key, opciones);
      }

      const copiados = await col.countDocuments();
      if (copiados !== docs.length) {
        throw new Error(`La colección ${nombre} quedó con ${copiados} documentos, se esperaban ${docs.length}.`);
      }
      conteos[nombre] = copiados;
    }

    await dbDestino.collection('_migracion').insertOne({ estado: 'completa', fecha: new Date(), conteos });
    const total = Object.values(conteos).reduce((a, b) => a + b, 0);
    console.log(`[migración BD] Completa: ${colecciones.length} colecciones, ${total} documentos. ${JSON.stringify(conteos)}`);
    return destinoUri;
  } catch (error) {
    console.error('[migración BD] FALLÓ; el servidor sigue con la base original:', (error as Error).message);
    return null;
  } finally {
    await origen?.close().catch(() => undefined);
    await destino?.close().catch(() => undefined);
  }
}
