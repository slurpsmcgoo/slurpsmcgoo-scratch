import './ui/styles.css';
import { App } from './app.ts';
import { initPhysics } from './sim/physics.ts';

await initPhysics();
new App(document.getElementById('stage') as HTMLCanvasElement, document.getElementById('ui')!);
document.getElementById('loading')?.remove();
