import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../src/database/database.service.js';
import { StorageReferencesService } from '../src/modules/storage/storage-references.service.js';
import { anonymous, as, createTestApp, type TestApp } from './support/app.js';
import { asUser, createTestDb, migrationsAvailable } from './support/pglite.js';
import { seedWorld, type World } from './support/world.js';

type Client = Awaited<ReturnType<typeof as>>;
type Node = {
  id: string;
  name: string;
  imagePath: string | null;
  imageAlt: string | null;
};
type PubNode = Node & { path: string; imageAlt: string | null };

/**
 * Optional images of catalog hierarchy items (migration 0074): upload scope, verification, replace / remove, clean-up of
 * single items and whole subtrees, reference protection, tenant isolation, the database rules and the public API.
 */
describe.skipIf(!migrationsAvailable)(
  'catalog hierarchy item images (e2e)',
  () => {
    let t: TestApp;
    let w: World;
    let alice: Client;
    let bob: Client;
    let reader: Client;
    let writer: Client;
    let noAccess: Client;

    const file = (tenant: string, nodeId: string) =>
      `${tenant}/catalog/${nodeId}/${randomUUID()}.png`;
    /** Puts a file "in storage" the way the browser would after the signed upload. */
    const upload = (tenant: string, nodeId: string) => {
      const path = file(tenant, nodeId);
      t.storage.upload(path);
      return path;
    };
    const create = (body: Record<string, unknown>, who = alice) =>
      who.post('/catalog/nodes', body);
    const createOk = async (body: Record<string, unknown>) =>
      (await create(body).expect(201)).body.data as Node;
    const getNode = async (id: string, who = alice) =>
      (await who.get(`/catalog/nodes/${id}`).expect(200)).body.data as Node;
    const owner = <T = Record<string, unknown>>(
      query: string,
      params: unknown[] = [],
    ) => t.db.asOwner(async (pg) => (await pg.query<T>(query, params)).rows);

    beforeAll(async () => {
      const db = await createTestDb();
      w = await seedWorld(db);
      t = await createTestApp(db);
      alice = await as(t, w.alice);
      bob = await as(t, w.bob);
      reader = await as(t, w.members.reader, w.tenantA);
      writer = await as(t, w.members.writer, w.tenantA);
      noAccess = await as(t, w.members.nothing, w.tenantA);
      await alice.post('/catalog/hierarchy', { name: 'Parts' }).expect(201);
      await alice.post('/catalog/levels', { name: 'Brand' }).expect(201);
      await alice.post('/catalog/levels', { name: 'Model' }).expect(201);
      await bob.post('/catalog/hierarchy', { name: 'Other' }).expect(201);
      await bob.post('/catalog/levels', { name: 'Top' }).expect(201);
    });
    afterAll(async () => {
      await t?.close();
      await t?.db.close();
    });

    describe('upload scope "catalog" (permissions, folder, tenant isolation)', () => {
      const files = [{ type: 'image/png', size: 1000 }];

      it('derives the folder from the verified organization, never from the request', async () => {
        const id = randomUUID();
        const res = await alice
          .post('/uploads/signed-urls', {
            scope: 'catalog',
            ownerId: id,
            files,
          })
          .expect(201);
        expect(res.body.data[0].path).toBe(`${w.tenantA}/catalog/${id}/0.png`);
        // the same request from the other organization lands in ITS folder, even with the same node id
        const other = await bob
          .post('/uploads/signed-urls', {
            scope: 'catalog',
            ownerId: id,
            files,
          })
          .expect(201);
        expect(other.body.data[0].path).toBe(
          `${w.tenantB}/catalog/${id}/0.png`,
        );
      });

      it('needs ownerId and valid files', async () => {
        await alice
          .post('/uploads/signed-urls', { scope: 'catalog', files })
          .expect(400);
        await alice
          .post('/uploads/signed-urls', {
            scope: 'catalog',
            ownerId: 'not-a-uuid',
            files,
          })
          .expect(400);
        await alice
          .post('/uploads/signed-urls', {
            scope: 'catalog',
            ownerId: randomUUID(),
            files: [{ type: 'image/gif', size: 10 }],
          })
          .expect(400);
        // (the video / 5 MB rules live in StorageService, which this suite replaces with an in-memory fake)
      });

      it('needs catalog:manage (products write): readers and members without access are refused', async () => {
        const body = { scope: 'catalog', ownerId: randomUUID(), files };
        await reader.post('/uploads/signed-urls', body).expect(403);
        await noAccess.post('/uploads/signed-urls', body).expect(403);
        await writer.post('/uploads/signed-urls', body).expect(201);
      });

      it('keeps the other scopes unchanged', async () => {
        const id = randomUUID();
        const product = await alice
          .post('/uploads/signed-urls', {
            scope: 'product',
            ownerId: id,
            files,
          })
          .expect(201);
        expect(product.body.data[0].path).toBe(`${w.tenantA}/${id}/0.png`);
        const collection = await alice
          .post('/uploads/signed-urls', {
            scope: 'collection',
            ownerId: id,
            files,
          })
          .expect(201);
        expect(collection.body.data[0].path).toBe(
          `${w.tenantA}/collections/${id}/0.png`,
        );
      });
    });

    describe('storage policy function for catalog paths', () => {
      const can = async (user: string, path: string) =>
        (
          await asUser(t.db, user, async (tx) =>
            rowsOf<{ ok: boolean }>(
              await tx.execute(
                sql.raw(
                  `select public.can_write_storage_object('${path}') as ok`,
                ),
              ),
            ),
          )
        )[0].ok;

      it('allows products-write members of the organization only, for exactly this path shape', async () => {
        const path = `${w.tenantA}/catalog/${randomUUID()}/f.png`;
        expect(await can(w.alice, path)).toBe(true);
        expect(await can(w.members.writer, path)).toBe(true);
        expect(await can(w.members.reader, path)).toBe(false);
        expect(await can(w.members.nothing, path)).toBe(false);
        expect(await can(w.bob, path)).toBe(false); // another organization
        expect(await can(w.carol, path)).toBe(false); // belongs to nothing
        // and Bob can write in his own catalog folder only
        expect(
          await can(w.bob, `${w.tenantB}/catalog/${randomUUID()}/f.png`),
        ).toBe(true);
        expect(
          await can(w.alice, `${w.tenantB}/catalog/${randomUUID()}/f.png`),
        ).toBe(false);
      });
    });

    describe('create', () => {
      it('verifies the uploaded file and stores path and description', async () => {
        const id = randomUUID();
        const imagePath = upload(w.tenantA, id);
        const node = await createOk({
          id,
          name: 'Toyota',
          imagePath,
          imageAlt: 'Toyota logo',
        });
        expect(node).toMatchObject({ id, imagePath, imageAlt: 'Toyota logo' });
        expect(await getNode(id)).toMatchObject({ imagePath });
      });

      it('works without an image, and without an id', async () => {
        const node = await createOk({ name: 'No image' });
        expect(node.imagePath).toBeNull();
        expect(node.imageAlt).toBeNull();
      });

      it('requires the id together with the image path', async () => {
        const res = await create({
          name: 'No id',
          imagePath: upload(w.tenantA, randomUUID()),
        }).expect(400);
        expect(res.body.error.code).toBe('CATALOG_NODE_IMAGE_ID_REQUIRED');
      });

      it('refuses a description without an image', async () => {
        const res = await create({
          id: randomUUID(),
          name: 'Alt only',
          imageAlt: 'x',
        }).expect(400);
        expect(res.body.error.code).toBe('CATALOG_NODE_IMAGE_ALT_INVALID');
      });

      it('refuses files that were never uploaded, belong to another item or organization, or use traversal', async () => {
        const id = randomUUID();
        // never uploaded
        await create({ id, name: 'A', imagePath: file(w.tenantA, id) }).expect(
          400,
        );
        // uploaded for ANOTHER item
        const foreignNode = upload(w.tenantA, randomUUID());
        await create({ id, name: 'B', imagePath: foreignNode }).expect(400);
        // another organization's folder
        const foreignTenant = `${w.tenantB}/catalog/${id}/${randomUUID()}.png`;
        t.storage.upload(foreignTenant);
        await create({ id, name: 'C', imagePath: foreignTenant }).expect(400);
        // traversal
        const sneaky = `${w.tenantA}/catalog/${id}/../${randomUUID()}.png`;
        t.storage.upload(sneaky);
        await create({ id, name: 'D', imagePath: sneaky }).expect(400);
        const rows = await owner('select 1 from catalog_nodes where id = $1', [
          id,
        ]);
        expect(rows).toHaveLength(0);
      });

      it('refuses a description longer than 200 characters', async () => {
        const id = randomUUID();
        await create({
          id,
          name: 'Long alt',
          imagePath: upload(w.tenantA, id),
          imageAlt: 'x'.repeat(201),
        }).expect(400);
      });

      it('refuses an id that is already used (409) and leaves the existing image alone', async () => {
        const id = randomUUID();
        const imagePath = upload(w.tenantA, id);
        await createOk({ id, name: 'Taken', imagePath });
        const second = upload(w.tenantA, id);
        const res = await create({
          id,
          name: 'Taken again',
          imagePath: second,
        }).expect(409);
        expect(res.body.error.code).toBe('ID_TAKEN');
        expect(t.storage.removed).not.toContain(imagePath);
        expect((await getNode(id)).imagePath).toBe(imagePath);
      });

      it('a failed save after a successful upload leaves the file (never a broken item)', async () => {
        const id = randomUUID();
        const imagePath = upload(w.tenantA, id);
        await createOk({ name: 'Dup slug', slug: 'dup-slug' });
        await create({ id, name: 'Dup', slug: 'dup-slug', imagePath }).expect(
          409,
        );
        expect(
          await owner('select 1 from catalog_nodes where id = $1', [id]),
        ).toHaveLength(0);
        expect(t.storage.objects.has(imagePath)).toBe(true);
        expect(t.storage.removed).not.toContain(imagePath);
      });
    });

    describe('update: replace, keep and remove', () => {
      let id: string;
      let first: string;

      beforeAll(async () => {
        id = randomUUID();
        first = upload(w.tenantA, id);
        await createOk({
          id,
          name: 'Honda',
          imagePath: first,
          imageAlt: 'Honda logo',
        });
      });

      it('keeps the image when imagePath is left out or unchanged, and edits only the description', async () => {
        await alice
          .patch(`/catalog/nodes/${id}`, { name: 'Honda Motors' })
          .expect(200);
        const same = await alice
          .patch(`/catalog/nodes/${id}`, {
            imagePath: first,
            imageAlt: 'New alt',
          })
          .expect(200);
        expect(same.body.data).toMatchObject({
          imagePath: first,
          imageAlt: 'New alt',
        });
        expect(t.storage.removed).not.toContain(first);
        const cleared = await alice
          .patch(`/catalog/nodes/${id}`, { imageAlt: '' })
          .expect(200);
        expect(cleared.body.data).toMatchObject({
          imagePath: first,
          imageAlt: null,
        });
        await alice
          .patch(`/catalog/nodes/${id}`, { imageAlt: 'Honda logo' })
          .expect(200);
      });

      it('refuses a replacement that was never uploaded and keeps (and does not delete) the current image', async () => {
        await alice
          .patch(`/catalog/nodes/${id}`, { imagePath: file(w.tenantA, id) })
          .expect(400);
        await alice
          .patch(`/catalog/nodes/${id}`, {
            imagePath: upload(w.tenantA, randomUUID()),
          })
          .expect(400);
        expect((await getNode(id)).imagePath).toBe(first);
        expect(t.storage.removed).not.toContain(first);
      });

      it('replaces the image: the old file is removed only after the change is saved', async () => {
        const second = upload(w.tenantA, id);
        const res = await alice
          .patch(`/catalog/nodes/${id}`, { imagePath: second })
          .expect(200);
        expect(res.body.data).toMatchObject({
          imagePath: second,
          imageAlt: 'Honda logo',
        });
        expect(t.storage.removed).toContain(first);
        expect(t.storage.objects.has(second)).toBe(true);
        first = second;
      });

      it('does not remove the old file when the save itself fails', async () => {
        await createOk({ name: 'Slug holder', slug: 'slug-holder' });
        const next = upload(w.tenantA, id);
        await alice
          .patch(`/catalog/nodes/${id}`, {
            imagePath: next,
            slug: 'slug-holder',
          })
          .expect(409);
        expect((await getNode(id)).imagePath).toBe(first);
        expect(t.storage.removed).not.toContain(first);
        expect(t.storage.objects.has(first)).toBe(true);
      });

      it('refuses a description without an image', async () => {
        const plain = await createOk({ name: 'Plain' });
        const res = await alice
          .patch(`/catalog/nodes/${plain.id}`, { imageAlt: 'x' })
          .expect(400);
        expect(res.body.error.code).toBe('CATALOG_NODE_IMAGE_ALT_INVALID');
      });

      it('removes the image and its description, then deletes the file', async () => {
        const res = await alice
          .patch(`/catalog/nodes/${id}`, { imagePath: null })
          .expect(200);
        expect(res.body.data).toMatchObject({
          imagePath: null,
          imageAlt: null,
        });
        expect(t.storage.removed).toContain(first);
        // idempotent
        await alice
          .patch(`/catalog/nodes/${id}`, { imagePath: null })
          .expect(200);
      });
    });

    describe('permissions and tenant isolation', () => {
      it('only products-write members change images; readers can see them', async () => {
        const id = randomUUID();
        const imagePath = upload(w.tenantA, id);
        await createOk({ id, name: 'Perm', imagePath });
        expect((await getNode(id, reader)).imagePath).toBe(imagePath);
        await reader
          .patch(`/catalog/nodes/${id}`, { imagePath: null })
          .expect(403);
        await noAccess.get(`/catalog/nodes/${id}`).expect(403);
        await writer
          .patch(`/catalog/nodes/${id}`, { imageAlt: 'by writer' })
          .expect(200);
        await create(
          { id: randomUUID(), name: 'X', imagePath: imagePath },
          reader,
        ).expect(403);
      });

      it("another organization can neither see, change nor use a node's image", async () => {
        const id = randomUUID();
        const imagePath = upload(w.tenantA, id);
        await createOk({ id, name: 'Private', imagePath });
        await bob.get(`/catalog/nodes/${id}`).expect(404);
        await bob
          .patch(`/catalog/nodes/${id}`, { imagePath: null })
          .expect(404);
        await bob.delete(`/catalog/nodes/${id}`).expect(404);
        expect((await getNode(id)).imagePath).toBe(imagePath);
        // Bob cannot point his own item at Alice's file
        const bobId = randomUUID();
        await create({ id: bobId, name: 'Steal', imagePath }, bob).expect(400);
      });
    });

    describe('delete and clean-up', () => {
      it('deleting an item removes its file after the delete committed', async () => {
        const id = randomUUID();
        const imagePath = upload(w.tenantA, id);
        await createOk({ id, name: 'Gone', imagePath });
        await alice.delete(`/catalog/nodes/${id}`).expect(200);
        expect(t.storage.removed).toContain(imagePath);
        await alice.get(`/catalog/nodes/${id}`).expect(404);
      });

      it('deleting an item without an image touches no storage', async () => {
        const plain = await createOk({ name: 'Plain delete' });
        const before = t.storage.removed.length;
        await alice.delete(`/catalog/nodes/${plain.id}`).expect(200);
        expect(t.storage.removed.length).toBe(before);
      });

      it('a refused delete (has children, no cascade) removes nothing', async () => {
        const parentId = randomUUID();
        const parentImg = upload(w.tenantA, parentId);
        await createOk({
          id: parentId,
          name: 'Parent keep',
          imagePath: parentImg,
        });
        const childId = randomUUID();
        const childImg = upload(w.tenantA, childId);
        await createOk({
          id: childId,
          name: 'Child keep',
          parentId,
          imagePath: childImg,
        });
        const res = await alice
          .delete(`/catalog/nodes/${parentId}`)
          .expect(409);
        expect(res.body.error.code).toBe('CATALOG_NODE_HAS_CHILDREN');
        expect(t.storage.removed).not.toContain(parentImg);
        expect(t.storage.removed).not.toContain(childImg);
        expect((await getNode(childId)).imagePath).toBe(childImg);
      });

      it('deleting a parent with cascade removes the files of every descendant', async () => {
        const rootId = randomUUID();
        const rootImg = upload(w.tenantA, rootId);
        await createOk({
          id: rootId,
          name: 'Cascade root',
          imagePath: rootImg,
        });
        const imgs: string[] = [];
        for (let i = 0; i < 3; i++) {
          const cid = randomUUID();
          const p = upload(w.tenantA, cid);
          imgs.push(p);
          await createOk({
            id: cid,
            name: `Cascade child ${i}`,
            parentId: rootId,
            imagePath: i === 2 ? undefined : p,
          });
        }
        await alice.delete(`/catalog/nodes/${rootId}?cascade=true`).expect(200);
        expect(t.storage.removed).toContain(rootImg);
        expect(t.storage.removed).toContain(imgs[0]);
        expect(t.storage.removed).toContain(imgs[1]);
        expect(t.storage.removed).not.toContain(imgs[2]); // never attached
      });

      it('a large subtree is cleaned up in batches without failing', async () => {
        const rootId = randomUUID();
        await createOk({ id: rootId, name: 'Big root' });
        const [level2] = await owner<{ id: string }>(
          'select id from catalog_levels where tenant_id = $1 and position = 2',
          [w.tenantA],
        );
        const [h] = await owner<{ id: string }>(
          'select id from catalog_hierarchies where tenant_id = $1',
          [w.tenantA],
        );
        await owner(
          `with ids as (select gen_random_uuid() as id, g from generate_series(1, 450) g)
           insert into catalog_nodes (id, tenant_id, hierarchy_id, level_id, parent_id, name, slug, image_path)
           select id, $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Bulk ' || g, 'bulk-' || g,
                  $1::text || '/catalog/' || id::text || '/f.png'
           from ids`,
          [w.tenantA, h.id, level2.id, rootId],
        );
        t.storage.removed.length = 0;
        await alice.delete(`/catalog/nodes/${rootId}?cascade=true`).expect(200);
        const removed = new Set(t.storage.removed);
        expect(removed.size).toBe(450);
        expect(
          await owner('select 1 from catalog_nodes where parent_id = $1', [
            rootId,
          ]),
        ).toHaveLength(0);
      });
    });

    describe('reference protection', () => {
      it('findReferencedPaths knows item images; removeUnreferencedObjects keeps a file an item still uses', async () => {
        const id = randomUUID();
        const imagePath = upload(w.tenantA, id);
        await createOk({ id, name: 'Referenced', imagePath });
        const unused = upload(w.tenantA, randomUUID());
        const refs = t.app.get(StorageReferencesService);
        const found = await t.db.service.withUser(w.alice, (tx) =>
          refs.findReferencedPaths(tx, w.tenantA, [imagePath, unused]),
        );
        expect(found.has(imagePath)).toBe(true);
        expect(found.has(unused)).toBe(false);
        // another organization's lookup never sees it
        const other = await t.db.service.withUser(w.bob, (tx) =>
          refs.findReferencedPaths(tx, w.tenantB, [imagePath]),
        );
        expect(other.size).toBe(0);

        t.storage.removed.length = 0;
        await refs.removeUnreferencedObjects(
          { id: w.alice, token: 't' } as never,
          w.tenantA,
          [imagePath, unused],
        );
        expect(t.storage.removed).toEqual([unused]);
        expect(t.storage.objects.has(imagePath)).toBe(true);
      });
    });

    describe('database rules (migration 0074)', () => {
      let id: string;
      let path: string;
      beforeAll(async () => {
        id = randomUUID();
        path = upload(w.tenantA, id);
        await createOk({ id, name: 'DB rules', imagePath: path });
      });

      it('the path must belong to this item and this organization', async () => {
        await expect(
          owner('update catalog_nodes set image_path = $1 where id = $2', [
            file(w.tenantA, randomUUID()),
            id,
          ]),
        ).rejects.toThrow(/catalog_nodes_image_path_check/);
        await expect(
          owner('update catalog_nodes set image_path = $1 where id = $2', [
            file(w.tenantB, id),
            id,
          ]),
        ).rejects.toThrow(/catalog_nodes_image_path_check/);
        await expect(
          owner('update catalog_nodes set image_path = $1 where id = $2', [
            `${w.tenantA}/catalog/${id}/../x.png`,
            id,
          ]),
        ).rejects.toThrow(/catalog_nodes_image_path_check/);
        await expect(
          owner('update catalog_nodes set image_path = $1 where id = $2', [
            `${w.tenantA}/${id}/x.png`,
            id,
          ]),
        ).rejects.toThrow(/catalog_nodes_image_path_check/);
      });

      it('the description needs an image and is 1 to 200 characters', async () => {
        await expect(
          owner('update catalog_nodes set image_alt = $1 where id = $2', [
            'x'.repeat(201),
            id,
          ]),
        ).rejects.toThrow(/catalog_nodes_image_alt_check/);
        await expect(
          owner('update catalog_nodes set image_alt = $1 where id = $2', [
            '   ',
            id,
          ]),
        ).rejects.toThrow(/catalog_nodes_image_alt_check/);
        const plain = await createOk({ name: 'Plain db' });
        await expect(
          owner('update catalog_nodes set image_alt = $1 where id = $2', [
            'alt',
            plain.id,
          ]),
        ).rejects.toThrow(/catalog_nodes_image_alt_check/);
        // clearing the image while an alt exists is refused too (the API clears both together)
        await owner('update catalog_nodes set image_alt = $1 where id = $2', [
          'ok',
          id,
        ]);
        await expect(
          owner('update catalog_nodes set image_path = null where id = $1', [
            id,
          ]),
        ).rejects.toThrow(/catalog_nodes_image_alt_check/);
        await owner(
          'update catalog_nodes set image_path = null, image_alt = null where id = $1',
          [id],
        );
        await owner('update catalog_nodes set image_path = $1 where id = $2', [
          path,
          id,
        ]);
      });

      it('members can update the two new columns (column grant) but still not the protected ones', async () => {
        const run = (query: string) =>
          asUser(t.db, w.alice, async (tx) =>
            rowsOf(await tx.execute(sql.raw(query))),
          );
        await run(
          `update catalog_nodes set image_alt = 'via grant' where id = '${id}'`,
        );
        await expect(
          run(`update catalog_nodes set depth = 5 where id = '${id}'`),
        ).rejects.toThrow();
      });

      it('both public functions keep SECURITY DEFINER, an empty search_path and no anonymous grant', async () => {
        const rows = await owner<{
          proname: string;
          prosecdef: boolean;
          proconfig: string[] | null;
          anon: boolean;
          authed: boolean;
        }>(
          `select p.proname, p.prosecdef, p.proconfig,
                  has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('get_public_catalog_tree', 'get_public_catalog_node')
           order by p.proname`,
        );
        expect(rows.map((r) => r.proname)).toEqual([
          'get_public_catalog_node',
          'get_public_catalog_tree',
        ]);
        for (const r of rows) {
          expect(r.prosecdef).toBe(true);
          expect(JSON.stringify(r.proconfig)).toMatch(/search_path=/);
          expect(r.anon).toBe(false);
          expect(r.authed).toBe(true);
        }
      });
    });

    describe('public catalog API', () => {
      const base = '/public/storefronts/alpha-shop/catalog';
      const ids = { toyota: '', camry: '', corolla: '', honda: '' };
      const imgs = { toyota: '', camry: '', corolla: '' };

      beforeAll(async () => {
        // a clean slate for this organization: the earlier groups left items behind
        await owner('delete from catalog_nodes where tenant_id = $1', [
          w.tenantA,
        ]);
        const add = async (
          key: keyof typeof ids,
          name: string,
          status: 'active' | 'draft',
          parent?: string,
          withImage = true,
        ) => {
          const id = randomUUID();
          const imagePath = withImage ? upload(w.tenantA, id) : undefined;
          await createOk({
            id,
            name,
            status,
            ...(parent ? { parentId: parent } : {}),
            ...(imagePath ? { imagePath, imageAlt: `${name} picture` } : {}),
          });
          ids[key] = id;
          if (key in imgs && imagePath)
            imgs[key as keyof typeof imgs] = imagePath;
        };
        await add('toyota', 'Toyota', 'active');
        await add('honda', 'Honda', 'active', undefined, false);
        await add('camry', 'Camry', 'active', ids.toyota);
        await add('corolla', 'Corolla', 'draft', ids.toyota);
        await alice
          .patch('/catalog/hierarchy', { status: 'active' })
          .expect(200);
      });

      it('the tree returns imagePath and imageAlt for every active item (null without an image)', async () => {
        const res = await anonymous(t).get(`${base}/tree`).expect(200);
        const nodes = res.body.data.nodes as PubNode[];
        const toyota = nodes.find((n) => n.id === ids.toyota)!;
        expect(toyota).toMatchObject({
          imagePath: imgs.toyota,
          imageAlt: 'Toyota picture',
        });
        expect(nodes.find((n) => n.id === ids.camry)).toMatchObject({
          imagePath: imgs.camry,
        });
        expect(nodes.find((n) => n.id === ids.honda)).toMatchObject({
          imagePath: null,
          imageAlt: null,
        });
      });

      it('a draft item and its image never appear', async () => {
        const res = await anonymous(t).get(`${base}/tree`).expect(200);
        expect(JSON.stringify(res.body)).not.toContain(imgs.corolla);
        await anonymous(t).get(`${base}/nodes/toyota/corolla`).expect(404);
      });

      it('the node page returns the image of the item and of each child', async () => {
        const res = await anonymous(t).get(`${base}/nodes/toyota`).expect(200);
        expect(res.body.data.node).toMatchObject({
          id: ids.toyota,
          imagePath: imgs.toyota,
          imageAlt: 'Toyota picture',
        });
        const children = res.body.data.children as PubNode[];
        expect(children.map((c) => c.id)).toEqual([ids.camry]);
        expect(children[0]).toMatchObject({
          imagePath: imgs.camry,
          imageAlt: 'Camry picture',
        });
        expect(JSON.stringify(res.body)).not.toContain(imgs.corolla);
      });

      it('an item without an image answers null, and a removed image disappears', async () => {
        const honda = await anonymous(t).get(`${base}/nodes/honda`).expect(200);
        expect(honda.body.data.node).toMatchObject({
          imagePath: null,
          imageAlt: null,
        });
        await alice
          .patch(`/catalog/nodes/${ids.camry}`, { imagePath: null })
          .expect(200);
        const res = await anonymous(t)
          .get(`${base}/nodes/toyota/camry`)
          .expect(200);
        expect(res.body.data.node).toMatchObject({
          imagePath: null,
          imageAlt: null,
        });
      });

      it('does not leak images across organizations', async () => {
        const res = await anonymous(t)
          .get('/public/storefronts/beta-shop/catalog/tree')
          .expect(200);
        expect(JSON.stringify(res.body)).not.toContain(w.tenantA);
      });
    });
  },
);
