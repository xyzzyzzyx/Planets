import { OrbitingBody, PlanetConfig, RingConfig } from './celestial.model';

/** A planet orbiting the star; may carry rings (built by StarFactory) and moons. */
export class Planet extends OrbitingBody {
  declare readonly config: PlanetConfig;
  readonly rings: RingConfig[];

  constructor(config: PlanetConfig) {
    super(config);
    this.rings = config.rings ?? [];
  }
}
