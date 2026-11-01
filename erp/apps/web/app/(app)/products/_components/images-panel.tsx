'use client';

import { useRef, useState } from 'react';
import { api, errorText, type Image, type Product } from '../../../../lib/catalog-api';

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * CAT-06 thumbnails are made in the browser (D22): the server never decodes images, so it needs no native image
 * library and is not exposed to decompression bombs. Re-encoding also drops camera EXIF data from the thumbnail.
 */
async function makeThumbnail(file: File, size = 400): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.82));
  if (!blob || blob.type !== 'image/webp') return new Promise((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.85)); // Safari < 17 cannot encode WebP
  return blob;
}

const upload = async (blob: Blob, name: string) =>
  (await api<{ fileId: string }>(`/files?kind=product_image&name=${encodeURIComponent(name)}`, { method: 'POST', raw: blob })).data.fileId;

export function ImagesPanel({ product, canWrite, onChange }: { product: Product; canWrite: boolean; onChange: (p: Product) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const images = product.images;

  const refresh = async () => onChange((await api<Product>(`/products/${product.id}`)).data);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setError('');
    try {
      for (const file of Array.from(files)) {
        if (!TYPES.includes(file.type)) throw new Error(`${file.name}: use a JPEG, PNG or WebP image`);
        if (file.size > MAX_BYTES) throw new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB`);
        const fileId = await upload(file, file.name);
        const thumbFileId = await upload(await makeThumbnail(file), `thumb-${file.name}`);
        await api(`/products/${product.id}/images`, { method: 'POST', body: { fileId, thumbFileId, altText: product.name } });
      }
    } catch (e) { setError(e instanceof Error && !('code' in e) ? e.message : errorText(e)); }
    finally { setBusy(false); if (input.current) input.current.value = ''; await refresh().catch(() => {}); }
  };

  const reorder = async (ids: string[], primary: string) => {
    try { await api(`/products/${product.id}/images/order`, { method: 'PUT', body: { imageIds: ids, primaryImageId: primary } }); await refresh(); }
    catch (e) { setError(errorText(e)); }
  };
  const move = (img: Image, dir: -1 | 1) => {
    const ids = images.map((i) => i.id);
    const at = ids.indexOf(img.id);
    if (at + dir < 0 || at + dir >= ids.length) return;
    [ids[at], ids[at + dir]] = [ids[at + dir], ids[at]];
    reorder(ids, images.find((i) => i.isPrimary)?.id ?? ids[0]);
  };
  const remove = async (img: Image) => {
    if (!confirm('Remove this image?')) return;
    try { await api(`/products/${product.id}/images/${img.id}`, { method: 'DELETE' }); await refresh(); }
    catch (e) { setError(errorText(e)); }
  };

  return (
    <div className="ui-panel">
      <div className="ui-panel-head"><span className="ui-h3">Images</span><span className="ui-caption">{images.length}/10</span></div>
      <div className="ui-panel-body">
        {error && <div className="ui-error" role="alert" style={{ marginBottom: 'var(--space-2)' }}>{error}</div>}
        <ul style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-2)', listStyle: 'none', margin: 0, padding: 0 }}>
          {images.map((img, i) => (
            <li key={img.id} style={{ display: 'grid', gap: 'var(--space-1)' }}>
              <a href={img.url} target="_blank" rel="noreferrer">
                <img src={img.thumbnailUrl} alt={img.altText} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)', outline: img.isPrimary ? '2px solid var(--brand-ink)' : undefined, outlineOffset: -2 }} />
              </a>
              {img.isPrimary && <span className="ui-badge ui-badge--brand">Main</span>}
              {canWrite && (
                <div style={{ display: 'flex', gap: 2 }}>
                  <button className="ui-btn ui-btn--sm ui-btn--ghost ui-btn--icon" type="button" aria-label="Move left" disabled={i === 0} onClick={() => move(img, -1)}>‹</button>
                  <button className="ui-btn ui-btn--sm ui-btn--ghost ui-btn--icon" type="button" aria-label="Move right" disabled={i === images.length - 1} onClick={() => move(img, 1)}>›</button>
                  {!img.isPrimary && <button className="ui-btn ui-btn--sm ui-btn--ghost" type="button" onClick={() => reorder(images.map((x) => x.id), img.id)}>Main</button>}
                  <button className="ui-btn ui-btn--sm ui-btn--ghost ui-btn--icon" type="button" aria-label="Remove image" onClick={() => remove(img)}>✕</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {canWrite && images.length < 10 && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <input ref={input} type="file" accept={TYPES.join(',')} multiple hidden onChange={(e) => add(e.target.files)} />
            <button className="ui-btn ui-btn--sm" type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : '+ Add images'}</button>
          </div>
        )}
        <p className="ui-caption" style={{ margin: 'var(--space-2) 0 0' }}>JPG, PNG or WebP up to 5 MB.</p>
      </div>
    </div>
  );
}
