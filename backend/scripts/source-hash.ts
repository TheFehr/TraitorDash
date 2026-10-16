// Prints the source hash of this working tree, the same value /health reports for a running
// instance built from these sources:  bun run source-hash
import { computeSourceHash } from '../src/services/version'

console.log(computeSourceHash())
