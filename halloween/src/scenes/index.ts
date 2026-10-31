// Scene registry. To add a scene: write a factory in this folder that returns
// a `Scene`, add it here, give it a section under "scenes" in show.json, and
// add its id to show.playlist. Nothing else needs to change.

import type { Scene } from '../types.ts';
import { createApproachingGhost } from './approachingGhost.ts';
import { createShadowWalker } from './shadowWalker.ts';
import { createSkeletonMirror } from './skeletonMirror.ts';
import { createSoundSkull } from './soundSkull.ts';
import { createWatchingEyes } from './watchingEyes.ts';

export const SCENE_FACTORIES: (() => Scene)[] = [createShadowWalker, createSoundSkull, createWatchingEyes, createApproachingGhost, createSkeletonMirror];
