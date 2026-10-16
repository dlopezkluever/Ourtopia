import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { supabase } from '../../lib/supabase/client';
import { categories, errorMessage, listingDetailsSchema, listingDraftSchema, listingSchema, type Listing } from './model';

export function ListingForm({ userId, communityId, listing, onSaved, onCancel }: { userId: string; communityId: string; listing?: Listing; onSaved: (id: string) => void; onCancel: () => void }) {
  const draftKey = `listing-draft-${userId}-${communityId}-${listing?.id ?? 'new'}`;
  const [draft] = useState(() => {
    try { return listingDraftSchema.parse(JSON.parse(sessionStorage.getItem(draftKey) ?? 'null')); } catch { return null; }
  });
  const initial = draft ?? (listing ? { ...listing, availability: listing.listing_availability } : null);
  const [ranges, setRanges] = useState(initial?.availability ?? [{ starts_on: '', ends_on: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [intent, setIntent] = useState<{ payload: string; id: string } | null>(() => {
    try { return JSON.parse(sessionStorage.getItem(`${draftKey}-intent`) ?? 'null'); } catch { return null; }
  });
  function values(form: HTMLFormElement) {
    const fields = new FormData(form);
    return { ...Object.fromEntries(fields.entries()), availability: fields.getAll('starts_on').map((start, index) => ({ starts_on: String(start), ends_on: String(fields.getAll('ends_on')[index]) })) };
  }
  function persist(form: HTMLFormElement) { sessionStorage.setItem(draftKey, JSON.stringify(values(form))); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = listingDetailsSchema.safeParse(values(event.currentTarget));
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(' ')); return; }
    const payload = JSON.stringify(parsed.data);
    const id = intent?.payload === payload ? intent.id : crypto.randomUUID();
    setIntent({ payload, id }); setBusy(true); setError('');
    sessionStorage.setItem(`${draftKey}-intent`, JSON.stringify({ payload, id }));
    sessionStorage.setItem(draftKey, payload);
    try {
      const result = await supabase.rpc('save_listing', { p_intent_id: id, p_community_id: communityId, ...(listing ? { p_listing_id: listing.id } : {}), p_expected_version: listing?.version ?? 0, p_details: parsed.data });
      if (result.error) throw result.error;
      const saved = listingSchema.parse(result.data);
      sessionStorage.removeItem(draftKey);
      sessionStorage.removeItem(`${draftKey}-intent`);
      onSaved(saved.id);
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <section className="account-card listing-form"><h2>{listing ? 'Edit Listing' : 'Share an item'}</h2><p>Let your Community know what you can lend.</p>
    <form onSubmit={submit} onChange={event => persist(event.currentTarget)}>
      <fieldset disabled={busy}>
        <label htmlFor="listing-title">Title</label><input id="listing-title" name="title" defaultValue={initial?.title} required minLength={2} maxLength={120}/>
        <label htmlFor="listing-description">Description</label><textarea id="listing-description" name="description" defaultValue={initial?.description} required maxLength={5000}/>
        <label htmlFor="listing-category">Category</label><select id="listing-category" name="category" defaultValue={initial?.category ?? 'tools'}>{categories.map(category => <option key={category}>{category}</option>)}</select>
        <label htmlFor="listing-condition">Condition</label><textarea id="listing-condition" name="condition" defaultValue={initial?.condition} required maxLength={1000}/>
        <label htmlFor="listing-value">Estimated replacement value ($)</label><input id="listing-value" name="replacement_value" type="number" step="0.01" min="0" max="1000000" defaultValue={initial?.replacement_value ?? 0} required/>
        <p className="field-help">Borrowing is free. This is the estimated value of the item.</p>
        <label htmlFor="listing-pickup">Pickup notes</label><textarea id="listing-pickup" name="pickup_notes" defaultValue={initial?.pickup_notes} maxLength={2000}/>
        <label htmlFor="listing-terms">Lending conditions</label><textarea id="listing-terms" name="lending_conditions" defaultValue={initial?.lending_conditions} maxLength={2000}/>
        <label htmlFor="listing-score">Minimum Community Solidarity Score</label><input id="listing-score" name="minimum_score" type="number" min="0" max="100" defaultValue={initial?.minimum_score ?? 0} required/>
        <fieldset className="availability-fields"><legend>Explicit availability dates</legend><p>Both dates are inclusive. No recurrence.</p>{ranges.map((range, index) => <div className="availability-row" key={index}>
          <label>Available from {index + 1}<input name="starts_on" type="date" required value={range.starts_on} onChange={event => setRanges(ranges.map((value, i) => i === index ? { ...value, starts_on: event.target.value } : value))}/></label>
          <label>Available through {index + 1}<input name="ends_on" type="date" required value={range.ends_on} onChange={event => setRanges(ranges.map((value, i) => i === index ? { ...value, ends_on: event.target.value } : value))}/></label>
          {ranges.length > 1 && <button type="button" onClick={() => setRanges(ranges.filter((_, i) => i !== index))}>Remove range {index + 1}</button>}
        </div>)}<button type="button" disabled={ranges.length >= 24} onClick={() => setRanges([...ranges, { starts_on: '', ends_on: '' }])}>Add date range</button></fieldset>
        <label htmlFor="listing-gratitude">Optional gratitude or maintenance suggestion</label><textarea id="listing-gratitude" name="gratitude" defaultValue={initial?.gratitude} maxLength={1000}/>
        <p className="field-help">Optional only. No payment, priority benefit, or guaranteed approval.</p>
        {error && <p role="alert" className="error">{error}</p>}
        <Button type="submit" className="primary-button">{busy ? 'Saving...' : 'Save Listing'}</Button><button type="button" className="text-button" onClick={onCancel}>Cancel</button>
      </fieldset>
    </form>
  </section>;
}
