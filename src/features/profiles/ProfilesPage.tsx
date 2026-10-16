import { ArrowLeft, LockKeyhole, Users } from 'lucide-react';
import { HistoryList, ScoreCard, TrustIndicators } from '../reputation/Standing';
import { exchangeCount, globalExplanation, localExplanation, standingText } from '../reputation/model';
import { readCommunityName, readDirectory, readProfile, roleLabel, type ProfileRoute } from './model';
import { useAccessScopedRead } from './useAccessScopedRead';

function Unavailable({ message }: { message: string }) {
  return <section className="account-card profile-unavailable"><LockKeyhole/><h2>Profile unavailable.</h2><p role="alert">{message}</p><a href="/">Back to your Communities</a></section>;
}

export function ProfilesPage({ userId, route }: { userId: string; route: ProfileRoute }) {
  const { communityId, subjectId } = route;
  const state = useAccessScopedRead(userId, `${communityId}-${subjectId ?? 'directory'}`, async () => {
    const [name, directory, profile] = await Promise.all([
      readCommunityName(communityId),
      subjectId ? Promise.resolve(null) : readDirectory(communityId),
      subjectId ? readProfile(communityId, subjectId) : Promise.resolve(null),
    ]);
    return { name, directory, profile };
  });
  if (state.status === 'loading') return <p role="status" className="loading">Opening member standing…</p>;
  if (state.status === 'denied') return <Unavailable message={state.message}/>;
  const { name, directory, profile } = state.data;
  const directoryHref = `/communities/${communityId}/members`;

  if (directory) return <section className="profiles-layout">
    <a className="text-button back-link" href={`/communities/${communityId}`}><ArrowLeft size={16}/> {name} home</a>
    <span className="eyebrow"><Users size={14}/> MEMBER DIRECTORY</span>
    <h1>Members of {name}</h1>
    <p className="muted">Approved members and their Community Solidarity Score in {name}.</p>
    <ul className="directory" aria-label={`Members of ${name}`}>{directory.map(member => <li key={member.user_id}>
      <a href={`${directoryHref}/${member.user_id}`}><span className="avatar" aria-hidden="true">{member.email.charAt(0).toUpperCase()}</span><span className="directory-name">{member.email}</span></a>
      <span className="directory-meta">{roleLabel(member.role)}{member.user_id === userId && ' · You'}</span>
      <span className="directory-score">{standingText(member.score, member.title)}</span>
      <span className="directory-count">{exchangeCount(member.completed_interactions)}</span>
    </li>)}</ul>
  </section>;

  if (!profile) return <Unavailable message="This person is not an active member of this Community."/>;
  const self = profile.userId === userId;
  return <section className="profiles-layout" aria-labelledby="profile-title">
    <a className="text-button back-link" href={directoryHref}><ArrowLeft size={16}/> Members of {name}</a>
    <span className="eyebrow">MEMBER PROFILE · {name.toUpperCase()}</span>
    <h1 id="profile-title">{profile.email}</h1>
    <p className="muted">{roleLabel(profile.role)} · joined {new Date(profile.joinedAt).toLocaleDateString()}</p>
    <div className="score-grid">
      <ScoreCard label="Community Solidarity Score" score={profile.local.score} title={profile.local.title} completed={profile.local.completedInteractions} explanation={localExplanation}/>
      <ScoreCard label="Global Solidarity Score" score={profile.trust.globalScore} title={profile.globalTitle} completed={profile.trust.completedInteractions} explanation={globalExplanation}/>
    </div>
    <TrustIndicators trust={profile.trust}/>
    <HistoryList heading={`Reputation history in ${name}`} events={profile.history}/>
    <section className="shared-communities" aria-label="Shared Communities"><h3>Communities you share</h3><ul>{profile.sharedCommunities.map(community => <li key={community.communityId}><a href={`/communities/${community.communityId}/members/${profile.userId}`}>{community.name}</a> · {roleLabel(community.role)}</li>)}</ul></section>
    {self && <a className="text-button" href="/standing">See your full standing across Communities</a>}
  </section>;
}
