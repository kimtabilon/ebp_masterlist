import { Request, Response, Router } from 'express'
import { getTmpProductList, manufacturerList, query } from '../controller'
import { processBundlesMongo } from '../controller/sku_packed'
import { syncMongoToMysql } from '../controller/sync_master'
import { exportSameSkuToXlsx } from '../controller/filter/same_sku'
import { exportSameUpcToXlsx } from '../controller/filter/duplicate_upc'
import { exportNullUpcToXlsx } from '../controller/filter/null_upc'
import { insertAllNullManufacturerMapSkus } from '../controller/filter/null_man_map'
import { buildGroupedUpcData } from '../controller/filter'
import { importAlmoRaw } from '../controller/process_raw/almoRawInsert'
import buildAlmoResponseTable from '../controller/responseGather/almoResponseGather'

import { buildProductList, updatePriority, fixMissingCategoriesFastv3 } from '../controller/build_prod/productPipeline'
import { generateProdLIst, testIngram, testParallelRun } from '../controller/generate_master_list'
import { processBundlesMongo } from '../controller/sku_packed'

const route = Router()

route.post('/query', query)

route.get('/manufacturerList', manufacturerList)

route.get('/masterlist', getTmpProductList)
route.get('/4pack', processBundlesMongo)
route.get('/syncToSql', syncMongoToMysql)

route.get('/sameSKUdiffUPC', exportSameSkuToXlsx)
route.get('/sameUPCdiffSKUs', exportSameUpcToXlsx)
route.get('/nullManufacturer', insertAllNullManufacturerMapSkus)
route.get('/nullUpc', exportNullUpcToXlsx)
route.get('/grouped_upc', buildGroupedUpcData)
route.get('/importAlmo', importAlmoRaw)
route.get('/almoResponse', buildAlmoResponseTable)

route.get('/fixMissingCategoriesFastv3', fixMissingCategoriesFastv3)
route.get('/processBundlesMongo', processBundlesMongo)

route.get('/buildProductList', async (req: Request, res: Response) => {
    console.log('starting')
    await buildProductList()
    res.send('done')
})

route.get('/updatePriority', async (req: Request, res: Response) => {
    console.log('starting')
    await updatePriority()
    res.send('done')
})

route.get('/generateProdLIst', async (req: Request, res: Response) => {
    console.log('starting')
    await generateProdLIst()
    res.send('done')
})

route.get('/testIngram', async (req: Request, res: Response) => {
    console.log('starting')
    await testIngram()
    res.send('done')
})

route.get('/testParallelRun', async (req: Request, res: Response) => {
    console.log('starting')
    await testParallelRun()
    res.send('done')
})

export default route