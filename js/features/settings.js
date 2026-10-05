/* Paramètres (#/settings) : (1) connexions sociales + procédure LinkedIn repliable, (2) Dokploy, (3) session, (4) affichage (mode en direct), (5) à propos. */
import { connectionsCard } from './connections.js?v=16';
import { setLastInfra } from './infra-shared.js?v=16';
import { linkedinProcedure, dokploySection, sessionSection, displaySection, aboutSection } from './settings-sections.js?v=16';

const Api = window.Api;
export const title = 'Paramètres';
export const eyebrow = '';
export const usesToolbar = false;

export async function render() {
  const [status, infra] = await Promise.allSettled([Api.getStatus(), Api.getInfrastructure()]);
  for (const r of [status, infra]) if (r.status === 'rejected' && r.reason && r.reason.code === 'unauthenticated') throw r.reason;
  if (infra.status === 'fulfilled') setLastInfra(infra.value);
  const st = status.status === 'fulfilled' ? status.value : null;
  const markup = `${connectionsCard(status, linkedinProcedure(st))}${dokploySection(infra)}${sessionSection()}${displaySection()}${aboutSection(st)}`;
  return { markup };
}
