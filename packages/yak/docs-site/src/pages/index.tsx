import type {ReactNode} from 'react';
import {Redirect} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

// The site has no separate marketing homepage — visiting the root goes
// straight to the docs. The "why yak" pitch that used to live here moved
// to docs/why-yak.md, first in the sidebar, instead of gatekeeping entry.
// useBaseUrl matters here: this site deploys under /yak/, and a hardcoded
// "/docs/why-yak" would 404 there — it only happens to work when served
// at the domain root.
export default function Home(): ReactNode {
  return <Redirect to={useBaseUrl('/docs/why-yak')} />;
}
