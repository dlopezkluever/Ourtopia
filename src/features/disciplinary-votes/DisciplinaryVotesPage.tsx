import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ballotLabels, voteNoticeMessages, voteStateLabel, type DisciplinaryVote } from './model';
import { accessibleCommunities, administeredCommunities, castBallot, closeVote, enactRemoval, openVote, readDefenseVotes, readRoster, readVoteNotices, readVotes, respond } from './api';

type Community = { id: string; name: string };
type Member = Awaited<ReturnType<typeof readRoster>>[number];
type VoteNotice = Awaited<ReturnType<typeof readVoteNotices>>[number];
const dateTime = (value: string) => <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
const errorText = (failure: unknown) => failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : 'The action was not confirmed. Retry safely.';

function VoteCard({ vote, userId, isAdmin, refresh }: { vote: DisciplinaryVote; userId: string; isAdmin: boolean; refresh: () => void }) {
  const [responseBody, setResponseBody] = useState('');
  const [removalReason, setRemovalReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function act(work: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(message); setResponseBody(''); refresh(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }
  const responseAllowed = vote.can_respond;
  return <article className="disciplinary-vote" aria-label="Community disciplinary vote">
    <div className="disciplinary-vote-heading"><div><p className="eyebrow">Community disciplinary vote</p><h2>{voteStateLabel[vote.state]}</h2></div>
      <p><strong>Closes</strong> {dateTime(vote.closes_at)}</p></div>
    <p><strong>Allegation</strong> {vote.reason}</p>
    <p><strong>Eligible voters at opening</strong> {vote.eligible_count}</p>
    {vote.state === 'open' ? <p>The server enforces the deadline. A delayed closure cannot accept a late ballot.</p>
      : <p role="status"><strong>Recorded result</strong> {vote.state}. Turnout {vote.turnout}/{vote.eligible_count}. Removal votes {vote.remove_votes}. Keep votes {vote.retain_votes}. Closed {vote.closed_at && dateTime(vote.closed_at)}. Membership has not changed automatically.</p>}
    <section><h3>Submitted evidence</h3>{vote.evidence.map(item => <p key={item.id}>{item.body} <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></p>)}</section>
    <section><h3>Accused member response</h3>{vote.responses.map(item => <p key={item.id}>{item.body} <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></p>)}
      {responseAllowed && <form onSubmit={event => { event.preventDefault(); void act(() => respond(userId, vote.id, responseBody.trim()), 'Your response was submitted.'); }}>
        <label htmlFor={`response-${vote.id}`}>Your response</label>
        <textarea id={`response-${vote.id}`} required maxLength={4000} value={responseBody} onChange={event => setResponseBody(event.target.value)}/>
        <button className="primary-button" disabled={busy || !responseBody.trim()}>Submit response</button>
      </form>}
    </section>
    {vote.can_vote && !vote.my_ballot && <fieldset disabled={busy}><legend>Cast one private, final ballot</legend>
      {(['remove', 'retain'] as const).map(choice => <button key={choice} className="secondary-button" onClick={() => void act(() => castBallot(userId, vote.id, choice), 'Your ballot is recorded and cannot be changed.')}>{ballotLabels[choice]}</button>)}
    </fieldset>}
    {vote.my_ballot && <p role="status">Your ballot is recorded. It cannot be changed.</p>}
    {isAdmin && userId !== vote.accused_id && vote.can_close && <button className="secondary-button" disabled={busy} onClick={() => void act(() => closeVote(userId, vote.id), 'The recorded result is available.')}>Record vote result</button>}
    {isAdmin && userId !== vote.accused_id && vote.state === 'passed' && <form onSubmit={event => { event.preventDefault(); void act(() => enactRemoval(userId, vote.id, removalReason.trim()), 'The separate removal action was recorded.'); }}>
      <label htmlFor={`removal-reason-${vote.id}`}>Reason for the separate removal action</label>
      <textarea id={`removal-reason-${vote.id}`} required maxLength={1000} value={removalReason} onChange={event => setRemovalReason(event.target.value)}/>
      <button className="secondary-button" disabled={busy || !removalReason.trim()}>Enact voted removal</button>
    </form>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </article>;
}

export function DisciplinaryVotesPage({ userId }: { userId: string }) {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [admins, setAdmins] = useState<Community[]>([]);
  const [communityId, setCommunityId] = useState('');
  const [roster, setRoster] = useState<{ communityId: string; members: Member[] } | null>(null);
  const [votes, setVotes] = useState<DisciplinaryVote[]>([]);
  const [notices, setNotices] = useState<VoteNotice[]>([]);
  const [accusedId, setAccusedId] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const isAdmin = admins.some(community => community.id === communityId);
  const members = roster?.communityId === communityId ? roster.members : [];

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [active, managed, defense, ownNotices] = await Promise.all([accessibleCommunities(userId), administeredCommunities(userId), readDefenseVotes(), readVoteNotices(userId)]);
      setCommunities(active); setAdmins(managed);
      setNotices(ownNotices);
      const lists = await Promise.all(active.map(community => readVotes(community.id)));
      const allVotes = new Map<string, DisciplinaryVote>();
      [...lists.flat(), ...defense].forEach(vote => allVotes.set(vote.id, vote));
      setVotes([...allVotes.values()].sort((a, b) => b.opened_at.localeCompare(a.opened_at)));
      setCommunityId(current => current || managed[0]?.id || active[0]?.id || '');
    } catch (failure) { setError(errorText(failure)); }
  }, [userId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void refresh(); });
    return () => { active = false; };
  }, [refresh]);
  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    void readRoster(communityId).then(rows => { if (active) setRoster({ communityId, members: rows.filter(row => row.status === 'active' || row.status === 'suspended') }); })
      .catch(failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  }, [communityId, isAdmin]);

  async function createVote(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await openVote(userId, communityId, accusedId, reason.trim(), evidence.trim());
      setReason(''); setEvidence(''); setAccusedId(''); setNotice('The seven-day vote is open. Its eligible electorate is frozen.'); await refresh();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  const displayed = votes.filter(vote => vote.community_id === communityId || vote.accused_id === userId);
  return <section className="disciplinary-votes-page">
    <a href="/moderation">Community moderation</a><h1>Disciplinary votes</h1>
    <p>Removal votes stay open for seven days. The eligible electorate is fixed when a vote opens. A passing result requires at least 30% turnout, rounded up, and two-thirds of ballots for removal. A passing result never removes a member by itself.</p>
    {communities.length > 0 && <label>Community<select value={communityId} onChange={event => setCommunityId(event.target.value)}>{communities.map(community => <option key={community.id} value={community.id}>{community.name}</option>)}</select></label>}
    {admins.length > 0 && <label>Administrator Community<select value={admins.some(item => item.id === communityId) ? communityId : admins[0].id} onChange={event => setCommunityId(event.target.value)}>{admins.map(community => <option key={community.id} value={community.id}>{community.name}</option>)}</select></label>}
    {isAdmin && <form className="disciplinary-vote-form" onSubmit={event => void createVote(event)}>
      <h2>Open a seven-day removal vote</h2>
      <label>Accused member<select required value={accusedId} onChange={event => setAccusedId(event.target.value)}><option value="">Choose a member</option>{members.filter(member => member.user_id !== userId).map(member => <option key={member.user_id} value={member.user_id}>{member.email} · {member.status}</option>)}</select></label>
      <label htmlFor="disciplinary-reason">Reason</label>
      <textarea id="disciplinary-reason" required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)}/>
      <label htmlFor="disciplinary-evidence">Submitted evidence</label>
      <textarea id="disciplinary-evidence" required maxLength={4000} value={evidence} onChange={event => setEvidence(event.target.value)}/>
      <p>Votes close exactly seven days after opening. The server enforces the deadline in UTC.</p>
      <button className="primary-button" disabled={busy || !accusedId || !reason.trim() || !evidence.trim()}>Open removal vote</button>
    </form>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {notices.length > 0 && <section aria-label="Disciplinary vote notices"><h2>Your vote notices</h2>{notices.map(item => <p key={item.id}>{voteNoticeMessages[item.kind]} <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></p>)}</section>}
    <h2>Current and past votes</h2>
    {displayed.map(vote => <VoteCard key={vote.id} vote={vote} userId={userId} isAdmin={admins.some(community => community.id === vote.community_id)} refresh={() => void refresh()}/>) }
    {!displayed.length && <p>No votes are available for this Community.</p>}
  </section>;
}
