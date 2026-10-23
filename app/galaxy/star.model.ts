import { CelestialBody, CometConfig, RingConfig, StarConfig } from './celestial.model';

/** Life-cycle stage of a star (informational; the default is main sequence). */
export enum StarStage {
  NEBULA = 'Nebula (Giant Gas Cloud)',
  PROTOSTAR = 'Protostar',
  T_TAURI_PHASE = 'T-Tauri Phase',
  MAIN_SEQUENCE = 'Main Sequence',
  RED_GIANT_OR_SUPERGIANT = 'Red Giant or Supergiant',
  STELLAR_DEATH_AND_REMNANTS = 'Stellar Death and Remnants',
}

/** Root of a star system: planets and comets are its satellites; belts live in its ring group. */
export class Star extends CelestialBody {
  declare readonly config: StarConfig;
  stage: StarStage | string;
  rings: RingConfig[];
  comets: CometConfig[];
  composition?: string;
  heat?: number;
  energy?: number;
  radiance?: number;

  constructor(config: StarConfig) {
    super(config);
    this.stage = config.stage ?? StarStage.MAIN_SEQUENCE;
    this.composition = config.composition;
    this.heat = config.heat;
    this.energy = config.energy;
    this.radiance = config.radiance;
    this.rings = config.rings ?? [];
    this.comets = config.comets ?? [];
  }

  /** Find this star or any descendant by (case-insensitive) name. */
  findBody(name: string): CelestialBody | null {
    const lower = name.toLowerCase();
    for (const body of this.descendants()) if (body.name.toLowerCase() === lower) return body;
    return null;
  }
}
