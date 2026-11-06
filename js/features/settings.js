/* Paramètres (#/settings) : (1) connexions sociales + procédure LinkedIn repliable, (2) session, (3) affichage (mode en direct), (4) à propos. */
import { connectionsCard } from './connections.js?v=18';
import { linkedinProcedure, sessionSection, displaySection, aboutSection } from './settings-sections.js?v=18';

const Api = window.Api;
export const title = 'Paramètres';
export const eyebrow = '';
export const usesToolbar = false;

export async function render() {
  const [status] = await Promise.allSettled([Api.getStatus()]);
  if (status.status === 'rejected' && status.reason && status.reason.code === 'unauthenticated') throw status.reason;
  const st = status.status === 'fulfilled' ? status.value : null;
  const markup = `${connectionsCard(status, linkedinProcedure(st))}${sessionSection()}${displaySection()}${aboutSection(st)}`;
  return { markup };
}
