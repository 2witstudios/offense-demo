import Link from 'next/link';
import { prose } from './ui/prose-class';

export default function NotFound() {
  return (
    <main>
      <h1 className={prose.h1}>Not found</h1>
      <p className={prose.p}>This page does not exist.</p>
      <Link href="/">Return home</Link>
    </main>
  );
}
