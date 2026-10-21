import { useEffect, useState } from 'react';
import { Download, Leaf } from 'lucide-react';
import { readPilotMetrics } from './api';
import { pilotMetricSections, pilotMetricsCsv, type PilotMetrics } from './model';

export function PilotMetricsPage({ communityId }: { communityId: string }) {
  const [metrics, setMetrics] = useState<PilotMetrics>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void readPilotMetrics(communityId).then(value => {
      if (active) setMetrics(value);
    }).catch(() => {
      if (active) { setMetrics(undefined); setError('Pilot metrics are available only to an active administrator of this Community.'); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [communityId]);

  function exportCsv() {
    if (!metrics) return;
    const blob = new Blob([pilotMetricsCsv(metrics)], { type: 'text/csv;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `ourtopia-pilot-metrics-${metrics.communityId}.csv`;
    link.click();
    URL.revokeObjectURL(href);
  }

  if (loading) return <p role="status" className="loading">Reading this Community's persisted activity…</p>;
  if (error) return <main className="pilot-metrics"><h1>Pilot health</h1><p role="alert">{error}</p><a href="/">Back to your Community</a></main>;
  if (!metrics) return null;

  return <main className="pilot-metrics">
    <header className="pilot-metrics-header"><span className="eyebrow"><Leaf size={15}/> COMMUNITY PILOT</span><h1>Pilot health</h1><p>Persisted activity for {metrics.communityName}. Totals reconcile to the record IDs in the export.</p><button type="button" className="primary-button" onClick={exportCsv}><Download size={17}/> Download auditable CSV</button></header>
    {pilotMetricSections.map(section => <section className="pilot-metric-section" key={section.title} aria-labelledby={`metrics-${section.title}`}>
      <h2 id={`metrics-${section.title}`}>{section.title}</h2><dl className="pilot-metric-grid">{section.metrics.map(([label, key]) => <div className="pilot-metric-card" key={key}><dt>{label}</dt><dd>{metrics.counts[key].toLocaleString()}</dd></div>)}</dl>
    </section>)}
    <section className="pilot-metric-section" aria-labelledby="billing-title"><h2 id="billing-title">Stripe test subscriptions</h2><p className="pilot-simulated">Simulated billing only. These are test subscription records, not paid revenue or a requirement for Community access.</p><dl className="pilot-metric-grid"><div className="pilot-metric-card"><dt>Test subscriptions</dt><dd>{metrics.counts.testSubscriptions.toLocaleString()}</dd></div>{Object.entries(metrics.billing.statuses).map(([status, count]) => <div className="pilot-metric-card" key={status}><dt>{status}</dt><dd>{count.toLocaleString()}</dd></div>)}</dl></section>
    <section className="pilot-metric-section" aria-labelledby="milestones-title"><h2 id="milestones-title">Pilot validation milestones</h2><p>These targets help evaluate the experiment. They are not requirements for declaring the software complete.</p><ul className="pilot-milestones"><li><strong>One real Community</strong><span>{metrics.communityName}</span></li><li><strong>20 active members</strong><span>{metrics.counts.activeMembers} of 20</span></li><li><strong>Five completed Exchanges</strong><span>{metrics.counts.exchangesCompleted} of 5</span></li><li><strong>One repeat participant</strong><span>{metrics.counts.repeatParticipants} of 1</span></li></ul></section>
    <p className="pilot-metrics-footnote">Generated {new Date(metrics.generatedAt).toLocaleString()}. The export includes same-Community record IDs, statuses, and dates. It excludes messages, evidence, member identities, and private file links.</p>
  </main>;
}
