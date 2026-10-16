import { ArrowLeft } from 'lucide-react';
import { HistoryList, ScoreCard } from '../reputation/Standing';
import { globalExplanation, localExplanation } from '../reputation/model';
import { membershipLabel, readOwnReputation } from './model';
import { useAccessScopedRead } from './useAccessScopedRead';

export function OwnStanding({ userId }: { userId: string }) {
  const state = useAccessScopedRead(userId, 'own-standing', readOwnReputation);
  if (state.status === 'loading') return <p role="status" className="loading">Opening your standing…</p>;
  if (state.status === 'denied') return <section className="account-card"><h2>Standing unavailable.</h2><p role="alert">{state.message}</p></section>;
  const { global, communities } = state.data;
  return <section className="profiles-layout" aria-labelledby="standing-title">
    <a className="text-button back-link" href="/"><ArrowLeft size={16}/> Your Communities</a>
    <span className="eyebrow">YOUR STANDING</span>
    <h1 id="standing-title">Your Solidarity Scores</h1>
    <p className="muted">Every verified event behind your scores, across current and past memberships.</p>
    <div className="score-grid"><ScoreCard label="Global Solidarity Score" score={global.score} title={global.title} completed={global.completedInteractions} explanation={globalExplanation}/></div>
    {communities.map(community => <article className="standing-community" key={community.communityId} aria-labelledby={`standing-${community.communityId}`}>
      <h2 id={`standing-${community.communityId}`}>{community.name}</h2>
      <p className="muted">{membershipLabel(community.membershipStatus)}</p>
      <ScoreCard label={`Community Solidarity Score in ${community.name}`} score={community.local.score} title={community.local.title} completed={community.local.completedInteractions} explanation={localExplanation}/>
      <HistoryList heading={`Your history in ${community.name}`} events={community.history}/>
    </article>)}
  </section>;
}
