const ADJECTIVES: string[] = [

  'bold','calm','cold','cool','dark','deep','dim','dry','dull','fair',
  'fast','flat','free','full','good','hard','high','hot','icy','keen',
  'kind','lean','long','loud','low','mad','mild','neat','odd','old',
  'open','pale','pure','raw','real','rich','safe','shy','slim','slow',
  'soft','still','tall','thin','tiny','true','warm','wide','wild','wise',

  'amber','arid','ashen','azure','bare','bleak','brisk','crisp','dusty',
  'faint','feral','fiery','foggy','fresh','frosted','glacial','grand',
  'grave','grey','grim','harsh','heavy','hollow','humid','jade','jolly',
  'lofty','lost','lucky','lunar','muted','noble','north','oak','polar',
  'quiet','rainy','rough','royal','rugged','rustic','saline','sandy',
  'scarce','silent','silver','sky','sleek','sly','solar','sonic','stark',
  'steady','steel','stern','stiff','stone','stormy','strong','swift',
  'tame','taut','teal','thick','tight','tough','twilight','vast','void',

  'atomic','binary','chrome','clean','clear','clever','cobalt','copper',
  'coral','cosmic','covert','crystal','cyan','dense','dual','early','edge',
  'electric','exact','fixed','fluid','forged','frozen','gilded','glowing',
  'golden','idle','inert','inner','iron','jagged','kinetic','latent',
  'linear','liquid','lone','magnetic','massive','mellow','molten','mythic',
  'narrow','native','neural','neutral','neon','night','nimble','null',
  'optic','outer','passive','patient','phantom','pitch','planar','polished',
  'primal','radiant','rapid','remote','rigid','sealed','sheer','signal',
  'sparse','spectral','stable','static','stellar','strange','thermal',
  'tidal','traced','ultra','upper','vertical','vibrant','violet','viral',
  'wired','worn','young','prime','proud','sleek','smooth','spare','blazing',
];

const NOUNS: string[] = [
  'ant','bear','bird','buck','bull','crab','crane','crow','deer','dove',
  'eagle','elk','finch','fox','frog','gull','hawk','heron','hound','jay',
  'kite','lark','lion','lynx','mink','mole','moose','moth','mule','orca',
  'otter','owl','quail','ram','raven','seal','shark','shrew','snake','stork',
  'swan','toad','wren','bison','bison','boar','dingo','egret','gecko','ibis',
  'impala','jackal','lemur','llama','macaw','manta','narwhal','newt','osprey',
  'panda','pelican','python','rhino','robin','skunk','tapir','viper','walrus',
  'weasel','wolf','zebra',

  'arc','ash','bay','beam','blade','bolt','bone','brook','cave','chain',
  'cliff','cloud','coil','core','creek','dawn','delta','dune','dust',
  'ember','fang','fern','field','flare','flock','flux','foam','fog','ford',
  'forge','frost','gate','glade','haze','helm','hill','hive','hull','isle',
  'ivy','kelp','lake','leaf','ledge','lens','mast','mesa','mill','mist',
  'moon','moss','node','orb','peak','pine','pond','pool','pulse','rail',
  'reed','reef','ridge','rift','rim','rook','root','rose','rune','rush',
  'sage','shore','skiff','slate','slope','spar','spike','spire','star',
  'stem','stream','tide','vale','bluff','bog','brine','buoy','cairn','crest',
  'croft','dusk','fault','flint','flood','flow','flume','gale','gorge',
  'grain','grove','gulf','gust','heath','inlet','knoll','lava','lode',
  'loft','marsh','meadow','mire','moat','mortar','nebula','notch','orbit',
  'pass','peat','pillar','plain','plume','prairie','reach','relic','resin',
  'scarp','scrub','seam','shard','shelf','silt','slag','soil','span','spine',
  'spit','spool','spore','spur','stack','stump','surge','tarn','thorn',
  'timber','torrent','trench','trunk','tundra','turf','tusk','vent','vine',
  'wake','wisp','zone',
];

export function generateSlug(): string {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  return `${adj}-${noun}`;
}
