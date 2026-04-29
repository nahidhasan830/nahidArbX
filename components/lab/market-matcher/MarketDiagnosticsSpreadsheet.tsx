"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DiscoveryTab } from "./tabs/DiscoveryTab";
import { InspectorTab } from "./tabs/InspectorTab";
import { AnomalyXRayTab } from "./tabs/AnomalyXRayTab";
import { BrainCircuit, Activity, AlertTriangle } from "lucide-react";

export function MarketDiagnosticsSpreadsheet() {
  const [activeTab, setActiveTab] = useState("discovery");

  return (
    <div className="flex flex-col gap-4 w-full flex-1 min-h-0">
      <div className="flex items-center justify-between">
        <div>
           <h1 className="text-xl font-bold tracking-tight text-primary">Resolution Workbench</h1>
           <p className="text-sm text-muted-foreground mt-1">
             AI-enhanced diagnostics to surface, analyze, and resolve market mapping failures.
           </p>
        </div>
      </div>

      <Card className="flex flex-col flex-1 min-h-0 relative overflow-hidden py-0 gap-0 border-border">
        <Tabs defaultValue="discovery" value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 min-h-0">
          <div className="bg-muted/40 border-b border-border px-4 py-2 flex items-center justify-between shrink-0">
             <TabsList className="bg-background border border-border h-9">
                <TabsTrigger value="discovery" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                  <BrainCircuit className="size-3.5 mr-1.5" />
                  ML Discovery Engine
                </TabsTrigger>
                <TabsTrigger value="inspector" className="text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                  <Activity className="size-3.5 mr-1.5" />
                  Live Event Inspector
                </TabsTrigger>
                <TabsTrigger value="anomalies" className="text-xs data-[state=active]:bg-red-500/10 data-[state=active]:text-red-500">
                  <AlertTriangle className="size-3.5 mr-1.5" />
                  Anomaly X-Ray
                </TabsTrigger>
             </TabsList>
             
             {/* Simple Health Stats overview could go here */}
          </div>

          <TabsContent value="discovery" className="flex-1 min-h-0 m-0 data-[state=active]:flex flex-col">
            <DiscoveryTab clusters={[]} loading={false} />
          </TabsContent>
          
          <TabsContent value="inspector" className="flex-1 min-h-0 m-0 data-[state=active]:flex flex-col">
            <InspectorTab />
          </TabsContent>

          <TabsContent value="anomalies" className="flex-1 min-h-0 m-0 data-[state=active]:flex flex-col">
             <AnomalyXRayTab data={[]} loading={false} />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}
