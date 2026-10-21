import { useCallback, useEffect, useState } from 'react';
import { readAdministeredCommunities, readAuditLog, readOpenContent, readOwnNotices, readRoster, moderateContent, moderateMembership } from './api';
import { actionLabels, activeRestrictions, contentLabels, membershipActions, messageOf, pastTense, type AuditRow, type ContentItem, type MembershipAction, type OwnNotice, type RosterRow } from './model';

const when = (value: string) => <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
const statusLabels: Record<RosterRow['status'], string> = { pending: 'Pending approval', active: 'Active', suspended: 'Suspended', removed: 'Removed' };

// Restrictions are shown to the affected member. Existing Exchanges and issues stay usable to settle them.
export function AccessNotices({ userId }: { userId: string }) {
  const [restrictions, setRestrictions] = useState<OwnNotice[]>([]);
  useEffect(() => {
    let active = true;
    void readOwnNotices(userId).then(rows => { if (active) setRestrictions(activeRestrictions(rows)); }).catch(() => { if (active) setRestrictions([]); });
    return () => { active = false; };
  }, [userId]);
  if (!restrictions.length) return null;
  return <section className="access-notices" aria-label="Membership restrictions">
    {restrictions.map(notice => <p key={notice.community_id} role="status">
      <strong>Your membership is {notice.action === 'remove' ? 'removed' : 'suspended'}.</strong> Reason: {notice.reason}. New Listings, Need Posts, Borrow Requests, messages, and votes are paused. Exchanges and issues already linked to you stay available until they close.
    </p>)}
  </section>;
}

export function ModerationIndex({ userId }: { userId: string }) {
  const [communities, setCommunities] = useState<{ community_id: string; name: string }[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    readAdministeredCommunities(userId)
      .then(rows => { if (active) setCommunities(rows.map(row => ({ community_id: row.community_id, name: row.communities?.name ?? 'Community' }))); })
      .catch(failure => { if (active) setError(messageOf(failure)); });
    return () => { active = false; };
  }, [userId]);
  return <section className="moderation-index"><h1>Moderation</h1>
    {error && <p role="alert">{error}</p>}
    {communities === null && !error && <p role="status">Loading your administered Communities…</p>}
    {communities?.length === 0 && <p>You do not administer a Community.</p>}
    <ul>{communities?.map(row => <li key={row.community_id}><a href={`/moderation/${row.community_id}`}>{row.name}</a></li>)}</ul>
  </section>;
}

export function ModerationPanel({ userId, communityId }: { userId: string; communityId: string }) {
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [log, setLog] = useState<AuditRow[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => Promise.all([readRoster(communityId), readOpenContent(communityId), readAuditLog(communityId)]).then(([members, posts, audit]) => {
    setRoster(members); setContent(posts); setLog(audit); setError('');
  }).catch(failure => setError(messageOf(failure))).finally(() => setLoaded(true)), [communityId]);

  useEffect(() => {
    let active = true;
    void Promise.all([readRoster(communityId), readOpenContent(communityId), readAuditLog(communityId)]).then(([members, posts, audit]) => {
      if (!active) return;
      setRoster(members); setContent(posts); setLog(audit); setError('');
    }).catch(failure => { if (active) setError(messageOf(failure)); }).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [communityId]);

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(done); setReason(''); }
    catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(false); await load(); }
  }

  const reasonReady = reason.trim().length > 0;
  const allowed = (member: RosterRow, action: MembershipAction) => member.user_id !== userId && (
    (action === 'suspend' && member.status === 'active') || (action === 'reinstate' && member.status === 'suspended')
    || (action === 'remove' && (member.status === 'active' || member.status === 'suspended')));

  return <section className="moderation-panel" aria-label="Community moderation">
    <h1>Moderation</h1>
    <p className="moderation-intro">Every action needs a reason. Each action is recorded in the audit log and cannot be edited.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!loaded && <p role="status">Loading moderation tools…</p>}
    <label className="moderation-reason">Reason for the next action<textarea required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)}/></label>

    <h2>Members</h2>
    <ul className="moderation-members">
      {roster.map(member => <li key={member.user_id} className="moderation-row">
        <span>{member.email} · {member.role === 'administrator' ? 'Administrator' : 'Member'} · {statusLabels[member.status]}</span>
        <span className="moderation-actions">
          {membershipActions.filter(action => allowed(member, action)).map(action => <button key={action} className="secondary-button" disabled={busy || !reasonReady}
            onClick={() => void run(() => moderateMembership(userId, communityId, member.user_id, action, reason.trim()), `${member.email} ${pastTense[action]}.`)}>{actionLabels[action]} {member.email}</button>)}
        </span>
      </li>)}
    </ul>

    <h2>Open listings and posts</h2>
    {loaded && content.length === 0 && <p>No open Listings or Need Posts.</p>}
    <ul className="moderation-content">
      {content.map(item => <li key={`${item.kind}-${item.id}`} className="moderation-row">
        <span>{item.title} · {contentLabels[item.kind]}</span>
        <button className="secondary-button" disabled={busy || !reasonReady}
          onClick={() => void run(() => moderateContent(userId, communityId, item.kind, item.id, reason.trim()), `${item.title} withdrawn.`)}>Withdraw {item.title}</button>
      </li>)}
    </ul>

    <h2>Audit log</h2>
    {loaded && log.length === 0 && <p>No moderation actions yet.</p>}
    <ol className="moderation-log">
      {log.map(row => <li key={row.id}><strong>{actionLabels[row.action]}</strong> · {row.subject_kind === 'membership' ? 'membership' : contentLabels[row.subject_kind]} · {row.reason} · {when(row.created_at)}</li>)}
    </ol>
  </section>;
}

export function ModerationRoute({ userId, path }: { userId: string; path: string }) {
  const communityId = /^\/moderation\/([0-9a-f-]{36})$/.exec(path)?.[1];
  return communityId ? <ModerationPanel key={communityId} userId={userId} communityId={communityId}/> : <ModerationIndex userId={userId}/>;
}
