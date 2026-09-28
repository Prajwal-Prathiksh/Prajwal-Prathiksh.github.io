import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRoute, GetStaticPaths } from 'astro';

// Keeps PDF links from the old Jekyll site working without storing duplicate files.
const legacy: Record<string, string> = {
  'Prajwal-Prathiksh-Resume.pdf': 'prajwal-resume.pdf',
  'K-T-Prajwal-Prathiksh--Curriculum-Vitae.pdf': 'prajwal-cv.pdf',
  'curriculum_vitae.pdf': 'prajwal-cv.pdf',
};

export const getStaticPaths = (() =>
  Object.entries(legacy).map(([file, target]) => ({ params: { file }, props: { target } }))) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
  const pdf = await readFile(join(process.cwd(), 'public/documents', props.target));
  return new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } });
};
