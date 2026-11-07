import { describe } from 'vitest'
import { memoryStore } from '../src/index.js'
import { storeContract } from './helpers/store-contract.js'

describe('memoryStore', () => storeContract(() => memoryStore()))
